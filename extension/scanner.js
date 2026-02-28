/**
 * scanner.js - Entry Point (Phase 1 Refactored)
 * 
 * 責務: モジュールの初期化と依存関係の注入
 * - chrome.runtime.onMessage をリッスン
 * - スキャンリクエストを受け取り、Controller を起動
 * - 各モジュール（core.js, ui.js, controller.js）を統合
 */

// Message listener for scan requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'scanPage') {
        handleScanRequest(request, sendResponse);
        return true; // Keep channel open for async response
    }
});

/**
 * スキャンリクエストを処理
 * @param {Object} request - リクエストオブジェクト
 * @param {Function} sendResponse - レスポンス送信関数
 */
async function handleScanRequest(request, sendResponse) {
    try {
        const settings = typeof loadSettings !== 'undefined' ? await loadSettings() : window.settings;
        debugLog('[AI Meta Viewer] Scan request received, settings:', settings);

        // Show scanning overlay
        const overlayData = showScanningOverlay(0);
        const { overlay, updateProgress, cancelButton } = overlayData;

        let isCancelled = false;
        cancelButton.addEventListener('click', () => {
            isCancelled = true;
            overlay.remove();
        });

        // Execute scan
        const result = await executeScan(settings);

        if (isCancelled) {
            sendResponse({ success: false, error: 'Scan cancelled' });
            return;
        }

        overlay.remove();

        if (result.success && result.candidates.length > 0) {
            const context = {
                pageTitle: document.title,
                domain: window.location.hostname,
                url: window.location.href
            };
            displayScanResults(result.candidates, context);
            sendResponse({ success: true, count: result.candidates.length });
        } else {
            showNotification(result.error || 'No media found');
            sendResponse({ success: false, error: result.error });
        }
    } catch (error) {
        console.error('[AI Meta Viewer] Scan error:', error);
        showNotification('Scan failed: ' + error.message);
        sendResponse({ success: false, error: error.message });
    }
}

/**
 * Legacy scanAllImages function for backward compatibility
 */
async function scanAllImages() {
    const settings = typeof loadSettings !== 'undefined' ? await loadSettings() : window.settings;
    debugLog('[AI Meta Viewer] Starting full page scan...');

    const result = await executeScan(settings);

    if (result.success && result.candidates.length > 0) {
        const context = {
            pageTitle: document.title,
            domain: window.location.hostname,
            url: window.location.href
        };
        displayScanResults(result.candidates, context);
    } else {
        showNotification(result.error || 'No media found');
    }
}
