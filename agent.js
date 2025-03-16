const express = require('express');
const { google } = require('googleapis');
const winston = require('winston');
const path = require('path');
const bodyParser = require('body-parser');
const compression = require('compression');
const multer = require('multer');
const fs = require('fs').promises;
const { oauth2Client, getAccessToken, authUrl, isAuthenticated, checkAndRefreshToken } = require('./googleAuth');
const Tesseract = require('tesseract.js');
const pdfParse = require('pdf-parse');
const NodeCache = require('node-cache');
const { Worker } = require('worker_threads');

// Initialize cache with 5 minutes TTL
const cache = new NodeCache({ stdTTL: 300 });

// Express app setup
const app = express();
const port = 3000;

// Enable compression
app.use(compression());

// Configure multer for handling file uploads
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only image and PDF files are allowed'));
        }
    }
});

// Middleware
app.use(bodyParser.json());
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

// Logger setup
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'updates.log' })
    ],
});

// Initialize Google APIs
const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
const docs = google.docs({ version: 'v1', auth: oauth2Client });
const sheets = google.sheets({ version: 'v4', auth: oauth2Client });
const drive = google.drive({ version: 'v3', auth: oauth2Client });

// Helper function to process email attachments
async function processEmailAttachments(messageId) {
    try {
        const message = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full'
        });

        const attachments = message.data.payload.parts?.filter(part => 
            part.filename && part.mimeType?.startsWith('image/'));

        if (!attachments?.length) return null;

        const results = [];
        for (const attachment of attachments) {
            const attachmentData = await gmail.users.messages.attachments.get({
                userId: 'me',
                messageId: messageId,
                id: attachment.body.attachmentId
            });

            if (attachmentData.data.data) {
                const buffer = Buffer.from(attachmentData.data.data, 'base64');
                const text = await processImage(buffer);
                results.push({
                    filename: attachment.filename,
                    text: text
                });
            }
        }

        return results;
    } catch (error) {
        logger.error('Error processing email attachments:', error);
        throw error;
    }
}

// Helper function to create calendar event
async function createCalendarEvent(summary, description, startTime, endTime) {
    try {
        const event = {
            summary,
            description,
            start: {
                dateTime: startTime,
                timeZone: 'UTC'
            },
            end: {
                dateTime: endTime,
                timeZone: 'UTC'
            }
        };

        const response = await calendar.events.insert({
            calendarId: 'primary',
            resource: event
        });

        return response.data;
    } catch (error) {
        logger.error('Error creating calendar event:', error);
        throw error;
    }
}

// Helper function to update document
async function updateDocument(docId, content) {
    try {
        const requests = content.map(item => ({
            insertText: {
                location: {
                    index: 1
                },
                text: item + '\n'
            }
        }));

        await docs.documents.batchUpdate({
            documentId: docId,
            resource: {
                requests: requests
            }
        });
    } catch (error) {
        logger.error('Error updating document:', error);
        throw error;
    }
}

// Helper function to update spreadsheet
async function updateSpreadsheet(spreadsheetId, range, values) {
    try {
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range,
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [values]
            }
        });
    } catch (error) {
        logger.error('Error updating spreadsheet:', error);
        throw error;
    }
}

// Error handling middleware
app.use((err, req, res, next) => {
    logger.error('Error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
});

// Authentication routes
app.get('/auth/google', (req, res) => {
    logger.info('Starting Google auth flow', { authUrl });
    res.redirect(authUrl);
});

app.get('/auth/google/callback', async (req, res) => {
    try {
        const { code, error } = req.query;
        
        if (error) {
            logger.error('Auth callback received error:', { error });
            return res.status(400).send(`Authentication error: ${error}`);
        }

        if (!code) {
            logger.error('No authorization code received');
            return res.status(400).send('No authorization code received');
        }
        
        logger.info('Received auth callback with code');
        const tokens = await getAccessToken(code);
        logger.info('Successfully obtained tokens');
        res.redirect('/');
    } catch (error) {
        logger.error('Auth callback error:', { error: error.message, stack: error.stack });
        res.status(500).send(`Authentication failed: ${error.message}`);
    }
});

app.get('/auth/status', async (req, res) => {
    try {
        const authenticated = await isAuthenticated();
        logger.info('Auth status check:', { authenticated });
        res.json({ authenticated });
    } catch (error) {
        logger.error('Auth status check error:', error);
        res.status(500).json({ error: 'Failed to check authentication status', details: error.message });
    }
});

// Protected route middleware
const requireAuth = async (req, res, next) => {
    try {
        const authenticated = await isAuthenticated();
        if (!authenticated) {
            logger.warn('Unauthenticated request to protected route:', { path: req.path });
            return res.status(401).json({ error: 'Authentication required' });
        }
        next();
    } catch (error) {
        next(error);
    }
};

// Email API endpoints
app.get('/api/emails', requireAuth, async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 10;
        const cacheKey = `emails_${page}_${pageSize}`;
        
        // Check cache first
        const cachedEmails = cache.get(cacheKey);
        if (cachedEmails) {
            return res.json(cachedEmails);
        }

        await checkAndRefreshToken();
        const response = await gmail.users.messages.list({
            userId: 'me',
            maxResults: pageSize,
            pageToken: page > 1 ? await getPageToken(page, pageSize) : undefined
        });

        if (!response.data.messages) {
            return res.json({ emails: [], nextPageToken: null });
        }

        const emails = await Promise.all(response.data.messages.map(async (message) => {
            const email = await gmail.users.messages.get({
                userId: 'me',
                id: message.id,
                format: 'metadata',
                metadataHeaders: ['subject', 'date']
            });
            
            const subject = email.data.payload.headers.find(
                header => header.name.toLowerCase() === 'subject'
            )?.value || 'No Subject';

            return {
                id: message.id,
                subject,
                timestamp: parseInt(email.data.internalDate),
            };
        }));

        const result = {
            emails,
            nextPageToken: response.data.nextPageToken || null
        };

        // Cache the results
        cache.set(cacheKey, result);
        res.json(result);
    } catch (error) {
        logger.error('Error fetching emails:', error);
        next(error);
    }
});

// Process document from email attachments
app.post('/api/process-email-attachments', requireAuth, async (req, res, next) => {
    try {
        const { messageId } = req.body;
        if (!messageId) {
            return res.status(400).json({ error: 'Message ID is required' });
        }

        const cacheKey = `attachment_${messageId}`;
        const cachedResults = cache.get(cacheKey);
        if (cachedResults) {
            return res.json({ results: cachedResults });
        }

        const results = await processEmailAttachments(messageId);
        if (results) {
            cache.set(cacheKey, results);
        }
        res.json({ results });
    } catch (error) {
        next(error);
    }
});

// Process uploaded document
app.post('/api/process-document', requireAuth, upload.single('file'), async (req, res, next) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }

        const text = await processDocument(req.file.buffer, req.file.mimetype);
        res.json({ text });
    } catch (error) {
        next(error);
    }
});

// Calendar API endpoints
app.get('/api/calendar', requireAuth, async (req, res, next) => {
    try {
        await checkAndRefreshToken();
        const response = await calendar.events.list({
            calendarId: 'primary',
            timeMin: new Date().toISOString(),
            maxResults: 10,
            singleEvents: true,
            orderBy: 'startTime',
        });

        res.json(response.data.items || []);
    } catch (error) {
        logger.error('Error fetching calendar events:', error);
        next(error);
    }
});

app.post('/api/calendar', requireAuth, async (req, res, next) => {
    try {
        const { summary, description, startTime, endTime } = req.body;
        
        if (!summary || !startTime || !endTime) {
            return res.status(400).json({ 
                error: 'Missing required fields: summary, startTime, endTime' 
            });
        }

        const event = await createCalendarEvent(summary, description, startTime, endTime);
        res.json(event);
    } catch (error) {
        next(error);
    }
});

// Documents API endpoints
app.get('/api/docs', requireAuth, async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 10;
        const cacheKey = `docs_${page}_${pageSize}`;

        const cachedDocs = cache.get(cacheKey);
        if (cachedDocs) {
            return res.json(cachedDocs);
        }

        await checkAndRefreshToken();
        const response = await drive.files.list({
            q: "mimeType='application/vnd.google-apps.document'",
            fields: 'files(id, name, modifiedTime), nextPageToken',
            orderBy: 'modifiedTime desc',
            pageSize: pageSize,
            pageToken: page > 1 ? await getPageToken(page, pageSize) : undefined
        });

        const result = {
            docs: response.data.files.map(file => ({
                id: file.id,
                title: file.name,
                modifiedTime: file.modifiedTime,
            })),
            nextPageToken: response.data.nextPageToken || null
        };

        cache.set(cacheKey, result);
        res.json(result);
    } catch (error) {
        logger.error('Error fetching documents:', error);
        next(error);
    }
});

app.post('/api/docs/:docId', requireAuth, async (req, res, next) => {
    try {
        const { docId } = req.params;
        const { content } = req.body;

        if (!content || !Array.isArray(content)) {
            return res.status(400).json({ error: 'Content must be an array of strings' });
        }

        await updateDocument(docId, content);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

// Sheets API endpoints
app.get('/api/sheets', requireAuth, async (req, res, next) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const pageSize = parseInt(req.query.pageSize) || 10;
        const cacheKey = `sheets_${page}_${pageSize}`;

        const cachedSheets = cache.get(cacheKey);
        if (cachedSheets) {
            return res.json(cachedSheets);
        }

        await checkAndRefreshToken();
        const response = await drive.files.list({
            q: "mimeType='application/vnd.google-apps.spreadsheet'",
            fields: 'files(id, name, modifiedTime), nextPageToken',
            orderBy: 'modifiedTime desc',
            pageSize: pageSize,
            pageToken: page > 1 ? await getPageToken(page, pageSize) : undefined
        });

        const result = {
            sheets: response.data.files.map(file => ({
                id: file.id,
                title: file.name,
                modifiedTime: file.modifiedTime,
            })),
            nextPageToken: response.data.nextPageToken || null
        };

        cache.set(cacheKey, result);
        res.json(result);
    } catch (error) {
        logger.error('Error fetching spreadsheets:', error);
        next(error);
    }
});

app.post('/api/sheets/:spreadsheetId', requireAuth, async (req, res, next) => {
    try {
        const { spreadsheetId } = req.params;
        const { range, values } = req.body;

        if (!range || !values) {
            return res.status(400).json({ 
                error: 'Missing required fields: range, values' 
            });
        }

        await updateSpreadsheet(spreadsheetId, range, values);
        res.json({ success: true });
    } catch (error) {
        next(error);
    }
});

// Document processing function
async function processDocument(buffer, mimeType) {
    logger.info('Processing document', { mimeType });
    try {
        if (mimeType === 'application/pdf') {
            const data = await pdfParse(buffer);
            return data.text;
        } else {
            // Process image in a worker thread
            return new Promise((resolve, reject) => {
                const worker = new Worker(`
                    const { parentPort } = require('worker_threads');
                    const Tesseract = require('tesseract.js');

                    parentPort.on('message', async (imageBuffer) => {
                        try {
                            const { data: { text } } = await Tesseract.recognize(imageBuffer);
                            parentPort.postMessage(text);
                        } catch (error) {
                            parentPort.postMessage({ error: error.message });
                        }
                    });
                `, { eval: true });

                worker.on('message', (result) => {
                    if (result.error) {
                        reject(new Error(result.error));
                    } else {
                        resolve(result);
                    }
                    worker.terminate();
                });

                worker.on('error', reject);
                worker.postMessage(buffer);
            });
        }
    } catch (error) {
        logger.error('Document processing error:', error);
        throw new Error('Failed to process document');
    }
}

// Helper function to get page token for pagination
async function getPageToken(page, pageSize) {
    if (page <= 1) return undefined;
    
    let currentPage = 1;
    let currentToken = undefined;
    
    while (currentPage < page) {
        const response = await drive.files.list({
            pageSize: pageSize,
            pageToken: currentToken,
            fields: 'nextPageToken'
        });
        
        if (!response.data.nextPageToken) {
            return undefined;
        }
        
        currentToken = response.data.nextPageToken;
        currentPage++;
    }
    
    return currentToken;
}

// Performance metrics endpoint
app.post('/api/metrics', (req, res) => {
    const metrics = req.body;
    logger.info('Performance metrics:', metrics);
    res.status(200).json({ received: true });
});

// Start the server
app.listen(port, () => {
    logger.info(`Server running at http://localhost:${port}`);
    console.log(`Server running at http://localhost:${port}`);
});
