const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// Path to the credentials and token files
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

// Load client secrets from a local file
const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));

// Set up OAuth2 client
const oauth2Client = new google.auth.OAuth2(
  credentials.client_id,
  credentials.client_secret,
  credentials.redirect_uris[0]
);

// Store token to disk for later program executions
function saveToken(token) {
  try {
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(token));
    console.log('Token stored to', TOKEN_PATH);
  } catch (err) {
    console.error('Error saving token:', err);
  }
}

// Load saved token if it exists
function loadSavedToken() {
  try {
    if (fs.existsSync(TOKEN_PATH)) {
      const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
      oauth2Client.setCredentials(token);
      return true;
    }
  } catch (err) {
    console.error('Error loading saved token:', err);
  }
  return false;
}

// Check if token is expired and refresh if necessary
async function checkAndRefreshToken() {
  const tokens = oauth2Client.credentials;
  if (tokens && tokens.expiry_date && tokens.expiry_date <= Date.now()) {
    try {
      const { tokens: newTokens } = await oauth2Client.refreshToken(tokens.refresh_token);
      oauth2Client.setCredentials(newTokens);
      saveToken(newTokens);
      return true;
    } catch (err) {
      console.error('Error refreshing token:', err);
      return false;
    }
  }
  return true;
}

// Generate the URL for the user to authorize the application
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: [
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/spreadsheets'
  ],
});

// Function to get the access token
const getAccessToken = async (code) => {
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    saveToken(tokens);
    return tokens;
  } catch (err) {
    console.error('Error getting access token:', err);
    throw err;
  }
};

// Check authentication status
const isAuthenticated = async () => {
  if (!loadSavedToken()) {
    return false;
  }
  return await checkAndRefreshToken();
};

module.exports = { 
  oauth2Client, 
  getAccessToken, 
  authUrl, 
  isAuthenticated,
  checkAndRefreshToken 
};
