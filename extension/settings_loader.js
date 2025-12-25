// settings_loader.js - Settings Management for Content Scripts

// デフォルト設定
window.DEFAULT_SETTINGS = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000, // 500x500
    minImageSize: 120, // リンク付き画像の最小サイズ
    showAnalyzingBadge: true,
    analyzeEverywhere: false,
    excludedSites: [],
    ignoredMetadataKeys: ['XML:com.adobe.xmp'],
    ignoredSoftware: ['Adobe Photoshop', 'Adobe ImageReady', 'Celsys Studio Tool', 'GIMP', 'Paint.NET']
};

// 現在の設定（グローバル変数として公開）
window.settings = { ...DEFAULT_SETTINGS };

/**
 * 設定を非同期で読み込む
 * @returns {Promise<Object>} 読み込まれた設定オブジェクト
 */
window.loadSettings = async function () {
    try {
        const stored = await chrome.storage.sync.get(null); // すべての保存済み設定を取得
        window.settings = { ...DEFAULT_SETTINGS, ...stored }; // デフォルト値に保存済み値を上書き
        return window.settings;
    } catch (e) {
        console.error('[AI Meta Viewer] Failed to load settings:', e);
        return window.settings;
    }
};

/**
 * 除外サイト判定
 * @returns {boolean}
 */
window.isExcludedUrl = function () {
    const currentUrl = window.location.href;
    const hostname = window.location.hostname;

    if (!window.settings.excludedSites) return false;

    for (const pattern of window.settings.excludedSites) {
        if (!pattern) continue;

        // ワイルドカード変換 (* -> .*, ? -> .)
        // 正規表現特殊文字をエスケープしてからワイルドカードを変換
        const regexStr = ('^' + pattern + '$')
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 正規表現特殊文字をエスケープ
            .replace(/\*/g, '.*')  // * を .* に変換
            .replace(/\?/g, '.');  // ? を . に変換

        try {
            const regex = new RegExp(regexStr, 'i');
            if (regex.test(hostname) || regex.test(currentUrl)) {
                return true;
            }
        } catch (e) {
            console.error('[AI Meta Viewer] Invalid wildcard pattern:', pattern, e);
        }
    }
    return false;
};

// 設定更新メッセージを受信してグローバル設定を更新
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'settingsUpdated') {
        window.settings = request.settings;
        console.log('[AI Meta Viewer] Settings updated via message');
    }
});
