// options.js - 設定ページのロジック

// デフォルト設定
const DEFAULT_SETTINGS = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000,
    excludedSites: []
};

// DOM要素
const debugModeCheckbox = document.getElementById('debugMode');
const errorNotificationCheckbox = document.getElementById('errorNotification');
const minPixelCountInput = document.getElementById('minPixelCount');
const excludedSitesTextarea = document.getElementById('excludedSites');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const clearCacheBtn = document.getElementById('clearCache');
const statusMessage = document.getElementById('statusMessage');

// 設定を読み込む
async function loadSettings() {
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

    if (debugModeCheckbox) debugModeCheckbox.checked = settings.debugMode;
    if (errorNotificationCheckbox) errorNotificationCheckbox.checked = settings.errorNotification;
    if (minPixelCountInput) minPixelCountInput.value = settings.minPixelCount;
    if (excludedSitesTextarea) excludedSitesTextarea.value = settings.excludedSites.join('\n');
}

// 設定を保存する
async function saveSettings() {
    const excludedSites = excludedSitesTextarea ? excludedSitesTextarea.value
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0) : [];

    const settings = {
        debugMode: debugModeCheckbox ? debugModeCheckbox.checked : false,
        errorNotification: errorNotificationCheckbox ? errorNotificationCheckbox.checked : false,
        minPixelCount: parseInt(minPixelCountInput ? minPixelCountInput.value : '250000', 10) || 250000,
        excludedSites: excludedSites
    };

    // 入力値の検証
    if (settings.minPixelCount < 10000) {
        showStatus('最小画素数は10000以上である必要があります', 'error');
        return;
    }

    try {
        await chrome.storage.sync.set(settings);

        // Background scriptに設定変更を通知
        chrome.runtime.sendMessage({ action: 'settingsUpdated', settings: settings });

        // アクティブなタブにも通知（拡張機能ページを除外）
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        for (const tab of tabs) {
            // chrome-extension:// で始まるURLは除外（設定ページなど）
            if (tab.url && !tab.url.startsWith('chrome-extension://')) {
                try {
                    await chrome.tabs.sendMessage(tab.id, { action: 'settingsUpdated', settings: settings });
                } catch (e) {
                    // Content scriptが注入されていないタブの場合は無視
                    // (例: chrome://, about:blank, file:// など)
                }
            }
        }

        showStatus('設定を保存しました', 'success');
    } catch (error) {
        showStatus('保存に失敗しました: ' + error.message, 'error');
    }
}

// デフォルト設定にリセット
async function resetSettings() {
    if (!confirm('設定をデフォルトに戻しますか?')) {
        return;
    }

    try {
        await chrome.storage.sync.set(DEFAULT_SETTINGS);
        await loadSettings();
        showStatus('設定をデフォルトに戻しました', 'success');

        // Background scriptとContent scriptに設定変更を通知
        chrome.runtime.sendMessage({ action: 'settingsUpdated', settings: DEFAULT_SETTINGS });
    } catch (error) {
        showStatus('リセットに失敗しました: ' + error.message, 'error');
    }
}

// キャッシュをクリア
async function clearCache() {
    if (!confirm('メタデータのキャッシュをクリアしますか?\nページを再読み込みすると、画像のメタデータが再取得されます。')) {
        return;
    }

    try {
        // Background scriptにキャッシュクリアを依頼
        const response = await chrome.runtime.sendMessage({ action: 'clearCache' });

        if (response && response.success) {
            showStatus('キャッシュをクリアしました', 'success');
        } else {
            showStatus('キャッシュのクリアに失敗しました', 'error');
        }
    } catch (error) {
        showStatus('エラー: ' + error.message, 'error');
    }
}

// ステータスメッセージを表示
function showStatus(message, type = 'success') {
    if (!statusMessage) return;

    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type} show`;

    // 3秒後に非表示
    setTimeout(() => {
        statusMessage.classList.remove('show');
    }, 3000);
}

// イベントリスナーの設定
document.addEventListener('DOMContentLoaded', () => {
    // 設定を読み込む
    loadSettings();

    // 保存ボタン
    if (saveBtn) saveBtn.addEventListener('click', saveSettings);

    // リセットボタン
    if (resetBtn) resetBtn.addEventListener('click', resetSettings);

    // キャッシュクリアボタン
    if (clearCacheBtn) clearCacheBtn.addEventListener('click', clearCache);

    // Enterキーで保存
    if (minPixelCountInput) {
        minPixelCountInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                saveSettings();
            }
        });
    }
});
