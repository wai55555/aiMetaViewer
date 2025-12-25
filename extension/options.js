// options.js - Settings Page Logic

// Default Settings
const DEFAULT_SETTINGS = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000,
    minImageSize: 200,
    showAnalyzingBadge: true,
    analyzeEverywhere: false,
    excludedSites: [],
    ignoredMetadataKeys: ['XML:com.adobe.xmp'],
    ignoredSoftware: ['Adobe Photoshop', 'Adobe ImageReady', 'Celsys Studio Tool', 'GIMP', 'Paint.NET'],
    downloaderFolderMode: 'pageTitle',
    downloaderBaseFolder: 'AI_Meta_Viewer',
    downloaderUseRoot: false
};

// DOM Elements
const debugModeCheckbox = document.getElementById('debugMode');
const errorNotificationCheckbox = document.getElementById('errorNotification');
const minPixelCountInput = document.getElementById('minPixelCount');
const minImageSizeInput = document.getElementById('minImageSize');
const showAnalyzingBadgeCheckbox = document.getElementById('showAnalyzingBadge');
const analyzeEverywhereCheckbox = document.getElementById('analyzeEverywhere');
const excludedSitesTextarea = document.getElementById('excludedSites');
const ignoredMetadataKeysTextarea = document.getElementById('ignoredMetadataKeys');
const ignoredSoftwareTextarea = document.getElementById('ignoredSoftware');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const clearCacheBtn = document.getElementById('clearCache');
const clearAllDataBtn = document.getElementById('clearAllData');
const statusMessage = document.getElementById('statusMessage');
const downloaderFolderModeSelect = document.getElementById('downloaderFolderMode');
const downloaderBaseFolderInput = document.getElementById('downloaderBaseFolder');
const downloaderUseRootCheckbox = document.getElementById('downloaderUseRoot');
const baseFolderContainer = document.getElementById('baseFolderContainer');

// Data Statistics Elements
const cacheItemCountSpan = document.getElementById('cacheItemCount');
const storageUsageSpan = document.getElementById('storageUsage');
const blockListCountSpan = document.getElementById('blockListCount');
const statisticsErrorDiv = document.getElementById('statisticsError');

/**
 * オプション画面拡張クラス
 * データ統計表示と全データクリア機能を管理
 */
class OptionsPageEnhancer {
    /**
     * データ統計を表示する
     */
    static async displayDataStatistics() {
        try {
            const response = await chrome.runtime.sendMessage({ action: 'getDataStatistics' });

            if (response && response.success) {
                this.updateUI(response.statistics);
                this.hideStatisticsError();
            } else {
                const errorMsg = response?.error || 'Failed to retrieve data statistics';
                this.showStatisticsError(errorMsg);
            }
        } catch (error) {
            this.showStatisticsError(`Error retrieving statistics: ${error.message}`);
        }
    }

    /**
     * 全データクリアハンドラ
     */
    static async handleClearAllData() {
        if (!confirm(chrome.i18n.getMessage('confirmClearAllData') || 'Are you sure you want to clear all extension data? This action cannot be undone.')) {
            return;
        }

        try {
            const response = await chrome.runtime.sendMessage({ action: 'clearAllData' });

            if (response && response.success) {
                const clearedItems = response.clearedItems;
                const totalCleared = clearedItems.persistentCache + clearedItems.rangeBlockList + clearedItems.contentScriptCaches;

                showStatus(
                    chrome.i18n.getMessage('msgAllDataCleared') ||
                    `All data cleared successfully! Removed ${totalCleared} items (Cache: ${clearedItems.persistentCache}, Block List: ${clearedItems.rangeBlockList}, Content Scripts: ${clearedItems.contentScriptCaches})`,
                    'success'
                );

                // 統計を即座に更新
                await this.displayDataStatistics();
            } else {
                const errorMsg = response?.error || 'Failed to clear all data';
                showStatus(
                    chrome.i18n.getMessage('msgAllDataClearFailed') ||
                    `Failed to clear all data: ${errorMsg}`,
                    'error'
                );
            }
        } catch (error) {
            showStatus(
                chrome.i18n.getMessage('msgAllDataClearFailed') ||
                `Failed to clear all data: ${error.message}`,
                'error'
            );
        }
    }

    /**
     * UI更新
     * @param {Object} statistics - データ統計
     */
    static updateUI(statistics) {
        if (cacheItemCountSpan) {
            cacheItemCountSpan.textContent = statistics.persistentCache.itemCount.toLocaleString();
        }

        if (storageUsageSpan) {
            const usage = statistics.persistentCache.storageUsage;
            const usageText = usage > 0 ? this.formatBytes(usage) : 'Unknown';
            storageUsageSpan.textContent = usageText;
        }

        if (blockListCountSpan) {
            blockListCountSpan.textContent = statistics.rangeBlockList.domainCount.toLocaleString();
        }
    }

    /**
     * バイト数を人間が読みやすい形式にフォーマット
     * @param {number} bytes - バイト数
     * @returns {string} フォーマットされた文字列
     */
    static formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    /**
     * 統計エラーを表示
     * @param {string} message - エラーメッセージ
     */
    static showStatisticsError(message) {
        if (statisticsErrorDiv) {
            statisticsErrorDiv.textContent = message;
            statisticsErrorDiv.style.display = 'block';
        }
    }

    /**
     * 統計エラーを非表示
     */
    static hideStatisticsError() {
        if (statisticsErrorDiv) {
            statisticsErrorDiv.style.display = 'none';
        }
    }
}

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
    if (minImageSizeInput) minImageSizeInput.value = settings.minImageSize;
    if (showAnalyzingBadgeCheckbox) showAnalyzingBadgeCheckbox.checked = settings.showAnalyzingBadge;
    if (analyzeEverywhereCheckbox) analyzeEverywhereCheckbox.checked = settings.analyzeEverywhere;
    if (excludedSitesTextarea) excludedSitesTextarea.value = settings.excludedSites.join('\n');
    if (ignoredMetadataKeysTextarea) ignoredMetadataKeysTextarea.value = settings.ignoredMetadataKeys.join('\n');
    if (ignoredSoftwareTextarea) ignoredSoftwareTextarea.value = settings.ignoredSoftware.join('\n');
    if (downloaderFolderModeSelect) downloaderFolderModeSelect.value = settings.downloaderFolderMode;
    if (downloaderBaseFolderInput) downloaderBaseFolderInput.value = settings.downloaderBaseFolder || '';
    if (downloaderUseRootCheckbox) {
        downloaderUseRootCheckbox.checked = settings.downloaderUseRoot;
        updateBaseFolderVisibility();
    }

    // データ統計を表示
    await OptionsPageEnhancer.displayDataStatistics();
}

// Save settings
async function saveSettings() {
    const excludedSites = excludedSitesTextarea ? excludedSitesTextarea.value
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0) : [];

    const ignoredMetadataKeys = ignoredMetadataKeysTextarea ? ignoredMetadataKeysTextarea.value
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0) : [];

    const ignoredSoftware = ignoredSoftwareTextarea ? ignoredSoftwareTextarea.value
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0) : [];

    const settings = {
        debugMode: debugModeCheckbox ? debugModeCheckbox.checked : false,
        errorNotification: errorNotificationCheckbox ? errorNotificationCheckbox.checked : false,
        minPixelCount: parseInt(minPixelCountInput ? minPixelCountInput.value : '250000', 10) || 250000,
        minImageSize: parseInt(minImageSizeInput ? minImageSizeInput.value : '200', 10) || 200,
        showAnalyzingBadge: showAnalyzingBadgeCheckbox ? showAnalyzingBadgeCheckbox.checked : true,
        analyzeEverywhere: analyzeEverywhereCheckbox ? analyzeEverywhereCheckbox.checked : false,
        excludedSites: excludedSites,
        ignoredMetadataKeys: ignoredMetadataKeys,
        ignoredSoftware: ignoredSoftware,
        downloaderFolderMode: downloaderFolderModeSelect ? downloaderFolderModeSelect.value : 'pageTitle',
        downloaderBaseFolder: downloaderBaseFolderInput ? downloaderBaseFolderInput.value.trim() : 'AI_Meta_Viewer',
        downloaderUseRoot: downloaderUseRootCheckbox ? downloaderUseRootCheckbox.checked : false
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
            // 統計を更新
            await OptionsPageEnhancer.displayDataStatistics();
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

// Update base folder input visibility/enabled state
function updateBaseFolderVisibility() {
    if (!downloaderUseRootCheckbox || !baseFolderContainer) return;

    if (downloaderUseRootCheckbox.checked) {
        baseFolderContainer.style.opacity = '0.5';
        baseFolderContainer.style.pointerEvents = 'none';
        if (downloaderBaseFolderInput) downloaderBaseFolderInput.disabled = true;
    } else {
        baseFolderContainer.style.opacity = '1';
        baseFolderContainer.style.pointerEvents = 'auto';
        if (downloaderBaseFolderInput) downloaderBaseFolderInput.disabled = false;
    }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    loadSettings();

    if (saveBtn) saveBtn.addEventListener('click', saveSettings);
    if (resetBtn) resetBtn.addEventListener('click', resetSettings);
    if (clearCacheBtn) clearCacheBtn.addEventListener('click', clearCache);
    if (clearAllDataBtn) clearAllDataBtn.addEventListener('click', () => OptionsPageEnhancer.handleClearAllData());

    if (minPixelCountInput) {
        minPixelCountInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                saveSettings();
            }
        });
    }

    if (downloaderUseRootCheckbox) {
        downloaderUseRootCheckbox.addEventListener('change', updateBaseFolderVisibility);
    }
});
