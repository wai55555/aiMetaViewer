// background.js - Background Service Worker

// メタデータキャッシュ (URLごと)
const metadataCache = new Map();

/**
 * Content Scriptからのメッセージを処理
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchImageMetadata') {
        handleFetchImageMetadata(request.imageUrl)
            .then(sendResponse)
            .catch(error => {
                console.error('Metadata fetch error:', error);
                sendResponse({ success: false, error: error.message });
            });

        // 非同期レスポンスを返すため true を返す
        return true;
    }
});

/**
 * 画像を取得してメタデータを抽出
 * @param {string} imageUrl - 画像URL
 * @returns {Promise<Object>} - { success: boolean, metadata?: Object, error?: string }
 */
async function handleFetchImageMetadata(imageUrl) {
    // キャッシュチェック
    if (metadataCache.has(imageUrl)) {
        const cachedMetadata = metadataCache.get(imageUrl);
        return { success: true, metadata: cachedMetadata, cached: true };
    }

    try {
        // 画像データを取得
        const response = await fetch(imageUrl);

        if (!response.ok) {
            return { success: false, error: `HTTP ${response.status}` };
        }

        const buffer = await response.arrayBuffer();

        // 10MB制限
        if (buffer.byteLength > 10 * 1024 * 1024) {
            return { success: false, error: 'Image too large (>10MB)' };
        }

        // メタデータ抽出 (parser.jsの関数をインポート)
        // Service Workerでは importScripts を使用
        if (typeof extractMetadata !== 'function') {
            // parser.js が読み込まれていない場合はエラー
            return { success: false, error: 'Parser not loaded' };
        }

        const metadata = extractMetadata(buffer);

        // 空でない場合のみキャッシュ
        if (metadata && Object.keys(metadata).length > 0) {
            metadataCache.set(imageUrl, metadata);
            return { success: true, metadata: metadata };
        } else {
            return { success: true, metadata: {} };
        }

    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Service Worker起動時にparser.jsを読み込む
importScripts('parser.js');
