// options.js - 設定ページのロジック

// デフォルト設定
const DEFAULT_SETTINGS = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000
};

// 設定を読み込む
async function loadSettings() {
    const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

    document.getElementById('debugMode').checked = settings.debugMode;
    document.getElementById('errorNotification').checked = settings.errorNotification;
    document.getElementById('minPixelCount').value = settings.minPixelCount;
}

// 設定を保存する
async function saveSettings() {
    const settings = {
        debugMode: document.getElementById('debugMode').checked,
        errorNotification: document.getElementById('errorNotification').checked,
        minPixelCount: parseInt(document.getElementById('minPixelCount').value, 10)
    };

    // 入力値の検証
    if (isNaN(settings.minPixelCount) || settings.minPixelCount < 10000) {
        showStatus('最小画素数は10000以上である必要があります', 'error');
        return;
    }

    try {
        await chrome.storage.sync.set(settings);
        showStatus('設定を保存しました', 'success');

        // Background scriptとContent scriptに設定変更を通知
        chrome.runtime.sendMessage({ action: 'settingsUpdated', settings });
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
    const statusEl = document.getElementById('statusMessage');
    statusEl.textContent = message;
    statusEl.className = `status-message ${type} show`;

    // 3秒後に非表示
    setTimeout(() => {
        statusEl.classList.remove('show');
    }, 3000);
}

// イベントリスナーの設定
document.addEventListener('DOMContentLoaded', () => {
    // 設定を読み込む
    loadSettings();

    // 保存ボタン
    document.getElementById('saveBtn').addEventListener('click', saveSettings);

    // リセットボタン
    document.getElementById('resetBtn').addEventListener('click', resetSettings);

    // キャッシュクリアボタン
    document.getElementById('clearCache').addEventListener('click', clearCache);

    // Enterキーで保存
    document.getElementById('minPixelCount').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            saveSettings();
        }
    });
});
