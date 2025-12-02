// options.js - Settings Page Logic

// Default Settings
const DEFAULT_SETTINGS = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000,
    showAnalyzingBadge: true,
    excludedSites: []
};

// DOM Elements
const debugModeCheckbox = document.getElementById('debugMode');
const errorNotificationCheckbox = document.getElementById('errorNotification');
const minPixelCountInput = document.getElementById('minPixelCount');
const showAnalyzingBadgeCheckbox = document.getElementById('showAnalyzingBadge');
const excludedSitesTextarea = document.getElementById('excludedSites');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const clearCacheBtn = document.getElementById('clearCache');
const statusMessage = document.getElementById('statusMessage');

// Apply i18n texts
function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        const message = chrome.i18n.getMessage(key);
        if (message) {
            element.innerHTML = message;
        }
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach(element => {
        const key = element.getAttribute('data-i18n-placeholder');
        const message = chrome.i18n.getMessage(key);
        if (message) {
            element.placeholder = message;
        }
    });
}

// Load settings
async function loadSettings() {
    applyI18n(); // Apply translations first

    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

    if (debugModeCheckbox) debugModeCheckbox.checked = settings.debugMode;
    if (errorNotificationCheckbox) errorNotificationCheckbox.checked = settings.errorNotification;
    if (minPixelCountInput) minPixelCountInput.value = settings.minPixelCount;
    if (showAnalyzingBadgeCheckbox) showAnalyzingBadgeCheckbox.checked = settings.showAnalyzingBadge;
    if (excludedSitesTextarea) excludedSitesTextarea.value = settings.excludedSites.join('\n');
}

// Save settings
async function saveSettings() {
    const excludedSites = excludedSitesTextarea ? excludedSitesTextarea.value
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0) : [];

    const settings = {
        debugMode: debugModeCheckbox ? debugModeCheckbox.checked : false,
        errorNotification: errorNotificationCheckbox ? errorNotificationCheckbox.checked : false,
        minPixelCount: parseInt(minPixelCountInput ? minPixelCountInput.value : '250000', 10) || 250000,
        showAnalyzingBadge: showAnalyzingBadgeCheckbox ? showAnalyzingBadgeCheckbox.checked : true,
        excludedSites: excludedSites
    };

    // Validation
    if (settings.minPixelCount < 10000) {
        showStatus(chrome.i18n.getMessage('errorMinPixelCount'), 'error');
        return;
    }

    try {
        await chrome.storage.sync.set(settings);

        // Notify Background script
        chrome.runtime.sendMessage({ action: 'settingsUpdated', settings: settings });

        // Notify active tabs (excluding extension pages)
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        for (const tab of tabs) {
            if (tab.url && !tab.url.startsWith('chrome-extension://')) {
                try {
                    await chrome.tabs.sendMessage(tab.id, { action: 'settingsUpdated', settings: settings });
                } catch (e) {
                    // Ignore errors for tabs where content script is not injected
                }
            }
        }

        showStatus(chrome.i18n.getMessage('msgSaved'), 'success');
    } catch (error) {
        showStatus(chrome.i18n.getMessage('msgSaveFailed') + error.message, 'error');
    }
}

// Reset to defaults
async function resetSettings() {
    if (!confirm(chrome.i18n.getMessage('confirmReset'))) {
        return;
    }

    try {
        await chrome.storage.sync.set(DEFAULT_SETTINGS);
        await loadSettings();
        showStatus(chrome.i18n.getMessage('msgReset'), 'success');

        // Notify Background script
        chrome.runtime.sendMessage({ action: 'settingsUpdated', settings: DEFAULT_SETTINGS });
    } catch (error) {
        showStatus(chrome.i18n.getMessage('msgResetFailed') + error.message, 'error');
    }
}

// Clear cache
async function clearCache() {
    if (!confirm(chrome.i18n.getMessage('confirmClearCache'))) {
        return;
    }

    try {
        const response = await chrome.runtime.sendMessage({ action: 'clearCache' });

        if (response && response.success) {
            showStatus(chrome.i18n.getMessage('msgCacheCleared'), 'success');
        } else {
            showStatus(chrome.i18n.getMessage('msgCacheClearFailed'), 'error');
        }
    } catch (error) {
        showStatus(chrome.i18n.getMessage('msgCacheClearFailed') + error.message, 'error');
    }
}

// Show status message
function showStatus(message, type = 'success') {
    if (!statusMessage) return;

    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type} show`;

    setTimeout(() => {
        statusMessage.classList.remove('show');
    }, 3000);
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();

    if (saveBtn) saveBtn.addEventListener('click', saveSettings);
    if (resetBtn) resetBtn.addEventListener('click', resetSettings);
    if (clearCacheBtn) clearCacheBtn.addEventListener('click', clearCache);

    if (minPixelCountInput) {
        minPixelCountInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                saveSettings();
            }
        });
    }
});
