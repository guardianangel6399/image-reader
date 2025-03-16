// Global state
let updateInterval;
const state = {
    isAuthenticated: false,
    isDarkMode: window.matchMedia('(prefers-color-scheme: dark)').matches,
    isLoading: {
        emails: false,
        calendar: false,
        docs: false,
        sheets: false
    },
    tasks: {
        active: [],
        completed: []
    },
    pagination: {
        emails: { page: 1, hasMore: true },
        docs: { page: 1, hasMore: true },
        sheets: { page: 1, hasMore: true }
    },
    retryAttempts: {
        maxRetries: 3,
        retryDelay: 1000 // 1 second
    }
};

// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/public/js/service-worker.js')
            .then(registration => {
                console.log('ServiceWorker registration successful');
            })
            .catch(err => {
                console.log('ServiceWorker registration failed: ', err);
            });
    });
}

// Enhanced fetch with retry mechanism
async function fetchWithRetry(url, options = {}, retryCount = 0) {
    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response;
    } catch (error) {
        if (retryCount < state.retryAttempts.maxRetries) {
            await new Promise(resolve => 
                setTimeout(resolve, state.retryAttempts.retryDelay * Math.pow(2, retryCount))
            );
            return fetchWithRetry(url, options, retryCount + 1);
        }
        throw error;
    }
}

// Debounce function
function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

// DOM Elements
const elements = {
    statusIndicator: document.getElementById('statusIndicator'),
    authStatus: document.getElementById('authStatus'),
    authButton: document.getElementById('authButton'),
    darkModeToggle: document.getElementById('darkModeToggle'),
    uploadArea: document.getElementById('uploadArea'),
    uploadInput: document.getElementById('uploadInput'),
    createEventBtn: document.getElementById('createEventBtn'),
    createDocBtn: document.getElementById('createDocBtn'),
    updateSheetBtn: document.getElementById('updateSheetBtn'),
    addTaskBtn: document.getElementById('addTaskBtn'),
    taskLists: {
        active: document.getElementById('activeTasks'),
        completed: document.getElementById('completedTasks')
    },
    tabs: document.querySelectorAll('.tab-btn')
};

// Task Management Functions
function loadTasks() {
    const savedTasks = localStorage.getItem('tasks');
    if (savedTasks) {
        const { active, completed } = JSON.parse(savedTasks);
        state.tasks.active = active || [];
        state.tasks.completed = completed || [];
    }
    renderTasks();
}

function saveTasks() {
    localStorage.setItem('tasks', JSON.stringify(state.tasks));
}

function renderTasks() {
    // Render active tasks
    elements.taskLists.active.innerHTML = state.tasks.active.length ? 
        state.tasks.active.map((task, index) => createTaskHTML(task, index, false)).join('') :
        '<div class="update-item">No active tasks</div>';

    // Render completed tasks
    elements.taskLists.completed.innerHTML = state.tasks.completed.length ?
        state.tasks.completed.map((task, index) => createTaskHTML(task, index, true)).join('') :
        '<div class="update-item">No completed tasks</div>';
}

function createTaskHTML(task, index, isCompleted) {
    return `
        <div class="task-item" data-index="${index}">
            <div class="task-checkbox ${isCompleted ? 'completed' : ''}" onclick="toggleTask(${index}, ${isCompleted})">
                <span class="material-icons">done</span>
            </div>
            <div class="task-content ${isCompleted ? 'completed' : ''}">
                <div class="item-title">${task.title}</div>
                <div class="item-meta">
                    <span>Created: ${new Date(task.createdAt).toLocaleString()}</span>
                </div>
            </div>
            <div class="task-actions">
                <button onclick="deleteTask(${index}, ${isCompleted})" title="Delete Task">
                    <span class="material-icons">delete</span>
                </button>
            </div>
        </div>
    `;
}

function addTask(title) {
    const task = {
        title,
        createdAt: new Date().toISOString()
    };
    state.tasks.active.unshift(task);
    saveTasks();
    renderTasks();
    showNotification('Task added successfully', 'success');
}

function toggleTask(index, isCompleted) {
    const sourceArray = isCompleted ? state.tasks.completed : state.tasks.active;
    const targetArray = isCompleted ? state.tasks.active : state.tasks.completed;
    
    if (index >= 0 && index < sourceArray.length) {
        const task = sourceArray.splice(index, 1)[0];
        targetArray.unshift(task);
        saveTasks();
        renderTasks();
        showNotification(`Task marked as ${isCompleted ? 'active' : 'completed'}`, 'success');
    }
}

function deleteTask(index, isCompleted) {
    const array = isCompleted ? state.tasks.completed : state.tasks.active;
    if (index >= 0 && index < array.length) {
        array.splice(index, 1);
        saveTasks();
        renderTasks();
        showNotification('Task deleted successfully', 'success');
    }
}

function switchTab(tabName) {
    // Update tab buttons
    elements.tabs.forEach(tab => {
        tab.classList.toggle('active', tab.dataset.tab === tabName);
    });

    // Show/hide task lists
    elements.taskLists.active.style.display = tabName === 'active' ? 'block' : 'none';
    elements.taskLists.completed.style.display = tabName === 'completed' ? 'block' : 'none';
}

// Utility Functions
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;
    document.body.appendChild(notification);

    // Trigger animation
    setTimeout(() => notification.classList.add('show'), 100);

    // Remove notification
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

function setLoading(section, isLoading) {
    state.isLoading[section] = isLoading;
    const sectionElement = document.getElementById(`${section}Updates`);
    const loadingHtml = '<div class="loading">Loading...</div>';
    
    if (isLoading) {
        sectionElement.innerHTML = loadingHtml;
    }
}

// Authentication
async function checkAuth() {
    try {
        const response = await fetch('/auth/status');
        if (!response.ok) throw new Error('Failed to check auth status');
        
        const data = await response.json();
        state.isAuthenticated = data.authenticated;
        
        updateAuthUI();
        
        if (state.isAuthenticated) {
            startUpdates();
        } else {
            stopUpdates();
        }
    } catch (error) {
        console.error('Auth check error:', error);
        showNotification('Failed to check authentication status', 'error');
    }
}

function updateAuthUI() {
    if (state.isAuthenticated) {
        elements.statusIndicator.classList.add('authenticated');
        elements.authStatus.textContent = 'Connected to Google Services';
        elements.authButton.style.display = 'none';
    } else {
        elements.statusIndicator.classList.remove('authenticated');
        elements.authStatus.textContent = 'Not connected to Google Services';
        elements.authButton.style.display = 'inline-block';
    }
}

// Data Updates
function startUpdates() {
    updateAllData();
    updateInterval = setInterval(updateAllData, 30000);
}

function stopUpdates() {
    if (updateInterval) {
        clearInterval(updateInterval);
    }
    ['emails', 'calendar', 'docs', 'sheets'].forEach(section => {
        document.getElementById(`${section}Updates`).innerHTML = 
            '<div class="update-item">Please authenticate to view updates</div>';
    });
}

async function updateAllData() {
    if (!state.isAuthenticated) return;
    
    await Promise.all([
        updateEmails(),
        updateCalendar(),
        updateDocs(),
        updateSheets()
    ]);
}

// Email Updates
async function updateEmails(loadMore = false) {
    if (!loadMore) {
        setLoading('emails', true);
    }
    try {
        const response = await fetchWithRetry(`/api/emails?page=${state.pagination.emails.page}&pageSize=10`);
        if (!response.ok) throw new Error('Failed to fetch emails');
        
        const data = await response.json();
        const emailList = document.getElementById('emailUpdates');
        
        const emailsHtml = data.emails.map(email => `
            <div class="update-item">
                <div class="item-title">${email.subject}</div>
                <div class="item-meta">
                    <span>${new Date(email.timestamp).toLocaleString()}</span>
                </div>
            </div>
        `).join('');

        if (loadMore) {
            emailList.innerHTML += emailsHtml;
        } else {
            emailList.innerHTML = emailsHtml || '<div class="update-item">No recent emails</div>';
        }

        state.pagination.emails.hasMore = !!data.nextPageToken;
        if (state.pagination.emails.hasMore) {
            emailList.innerHTML += '<div class="load-more" onclick="loadMoreEmails()">Load More</div>';
        }
    } catch (error) {
        console.error('Error fetching emails:', error);
        showNotification('Failed to fetch emails', 'error');
    } finally {
        setLoading('emails', false);
    }
}

async function loadMoreEmails() {
    state.pagination.emails.page++;
    await updateEmails(true);
}

// Calendar Updates
async function updateCalendar() {
    setLoading('calendar', true);
    try {
        const response = await fetch('/api/calendar');
        if (!response.ok) throw new Error('Failed to fetch calendar events');
        
        const events = await response.json();
        const calendarList = document.getElementById('calendarUpdates');
        
        calendarList.innerHTML = events.map(event => `
            <div class="update-item">
                <div class="item-title">${event.summary}</div>
                <div class="item-meta">
                    <span>${new Date(event.start.dateTime || event.start.date).toLocaleString()}</span>
                </div>
            </div>
        `).join('') || '<div class="update-item">No upcoming events</div>';
    } catch (error) {
        console.error('Error fetching calendar events:', error);
        showNotification('Failed to fetch calendar events', 'error');
    } finally {
        setLoading('calendar', false);
    }
}

// Documents Updates
async function updateDocs(loadMore = false) {
    if (!loadMore) {
        setLoading('docs', true);
    }
    try {
        const response = await fetchWithRetry(`/api/docs?page=${state.pagination.docs.page}&pageSize=10`);
        if (!response.ok) throw new Error('Failed to fetch documents');
        
        const data = await response.json();
        const docList = document.getElementById('docUpdates');
        
        const docsHtml = data.docs.map(doc => `
            <div class="update-item">
                <div class="item-title">${doc.title}</div>
                <div class="item-meta">
                    <span>Last modified: ${new Date(doc.modifiedTime).toLocaleString()}</span>
                </div>
            </div>
        `).join('');

        if (loadMore) {
            docList.innerHTML += docsHtml;
        } else {
            docList.innerHTML = docsHtml || '<div class="update-item">No recent document updates</div>';
        }

        state.pagination.docs.hasMore = !!data.nextPageToken;
        if (state.pagination.docs.hasMore) {
            docList.innerHTML += '<div class="load-more" onclick="loadMoreDocs()">Load More</div>';
        }
    } catch (error) {
        console.error('Error fetching documents:', error);
        showNotification('Failed to fetch documents', 'error');
    } finally {
        setLoading('docs', false);
    }
}

async function loadMoreDocs() {
    state.pagination.docs.page++;
    await updateDocs(true);
}

// Sheets Updates
async function updateSheets(loadMore = false) {
    if (!loadMore) {
        setLoading('sheets', true);
    }
    try {
        const response = await fetchWithRetry(`/api/sheets?page=${state.pagination.sheets.page}&pageSize=10`);
        if (!response.ok) throw new Error('Failed to fetch spreadsheets');
        
        const data = await response.json();
        const sheetList = document.getElementById('sheetUpdates');
        
        const sheetsHtml = data.sheets.map(sheet => `
            <div class="update-item">
                <div class="item-title">${sheet.title}</div>
                <div class="item-meta">
                    <span>Last modified: ${new Date(sheet.modifiedTime).toLocaleString()}</span>
                </div>
            </div>
        `).join('');

        if (loadMore) {
            sheetList.innerHTML += sheetsHtml;
        } else {
            sheetList.innerHTML = sheetsHtml || '<div class="update-item">No recent spreadsheet updates</div>';
        }

        state.pagination.sheets.hasMore = !!data.nextPageToken;
        if (state.pagination.sheets.hasMore) {
            sheetList.innerHTML += '<div class="load-more" onclick="loadMoreSheets()">Load More</div>';
        }
    } catch (error) {
        console.error('Error fetching spreadsheets:', error);
        showNotification('Failed to fetch spreadsheets', 'error');
    } finally {
        setLoading('sheets', false);
    }
}

async function loadMoreSheets() {
    state.pagination.sheets.page++;
    await updateSheets(true);
}

// Debounced update functions
const debouncedUpdateEmails = debounce(updateEmails, 300);
const debouncedUpdateDocs = debounce(updateDocs, 300);
const debouncedUpdateSheets = debounce(updateSheets, 300);

// File Upload Handling
function handleDragOver(e) {
    e.preventDefault();
    e.stopPropagation();
    elements.uploadArea.classList.add('drag-over');
}

function handleDragLeave(e) {
    e.preventDefault();
    e.stopPropagation();
    elements.uploadArea.classList.remove('drag-over');
}

async function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    elements.uploadArea.classList.remove('drag-over');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        await handleFiles(files);
    }
}

async function handleFileSelect(e) {
    const files = e.target.files;
    if (files.length > 0) {
        await handleFiles(files);
    }
}

async function handleFiles(files) {
    for (const file of files) {
        if (!file.type.startsWith('image/') && file.type !== 'application/pdf') {
            showNotification('Please upload image or PDF files only', 'error');
            continue;
        }

        // Compress image before uploading if it's an image
        let fileToUpload = file;
        if (file.type.startsWith('image/')) {
            fileToUpload = await compressImage(file);
        }

        const formData = new FormData();
        formData.append('file', fileToUpload);

        try {
            const response = await fetchWithRetry('/api/process-document', {
                method: 'POST',
                body: formData
            });

            if (!response.ok) throw new Error('Failed to process document');
            
            const result = await response.json();
            showNotification(`${file.type === 'application/pdf' ? 'PDF' : 'Image'} processed successfully`, 'success');
            
            // Update the relevant sections based on the processed document
            await updateAllData();
        } catch (error) {
            console.error('Error processing document:', error);
            showNotification(`Failed to process ${file.type === 'application/pdf' ? 'PDF' : 'image'}`, 'error');
        }
    }
}

// Image compression utility
async function compressImage(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');

                // Calculate new dimensions (max 1200px width/height)
                let width = img.width;
                let height = img.height;
                const maxDimension = 1200;

                if (width > maxDimension || height > maxDimension) {
                    if (width > height) {
                        height = (height / width) * maxDimension;
                        width = maxDimension;
                    } else {
                        width = (width / height) * maxDimension;
                        height = maxDimension;
                    }
                }

                canvas.width = width;
                canvas.height = height;
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob((blob) => {
                    resolve(new File([blob], file.name, {
                        type: file.type,
                        lastModified: file.lastModified,
                    }));
                }, file.type, 0.8); // 80% quality
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
    });
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    // Initialize authentication and tasks
    checkAuth();
    loadTasks();

    // Dark mode toggle
    if (elements.darkModeToggle) {
        elements.darkModeToggle.addEventListener('click', () => {
            document.body.classList.toggle('dark-mode');
            state.isDarkMode = !state.isDarkMode;
        });
    }

    // File upload handlers
    if (elements.uploadArea) {
        elements.uploadArea.addEventListener('dragover', handleDragOver);
        elements.uploadArea.addEventListener('dragleave', handleDragLeave);
        elements.uploadArea.addEventListener('drop', handleDrop);
        elements.uploadArea.addEventListener('click', () => elements.uploadInput.click());
    }

    if (elements.uploadInput) {
        elements.uploadInput.addEventListener('change', handleFileSelect);
    }

    // Auth button handler
    if (elements.authButton) {
        elements.authButton.addEventListener('click', () => {
            window.location.href = '/auth/google';
        });
    }

    // Task management handlers
    if (elements.addTaskBtn) {
        elements.addTaskBtn.addEventListener('click', () => {
            const title = prompt('Enter task title:');
            if (title && title.trim()) {
                addTask(title.trim());
            }
        });
    }

    // Tab switching handlers
    elements.tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            switchTab(tab.dataset.tab);
        });
    });

    // Create/Update buttons handlers
    if (elements.createEventBtn) {
        elements.createEventBtn.addEventListener('click', () => {
            // Implement calendar event creation
        });
    }

    if (elements.createDocBtn) {
        elements.createDocBtn.addEventListener('click', () => {
            // Implement document creation
        });
    }

    if (elements.updateSheetBtn) {
        elements.updateSheetBtn.addEventListener('click', () => {
            // Implement sheet update
        });
    }
});
