// background.js - Universal Background Script (Chrome & Firefox)

// ブラウザAPI統一（Chrome/Firefox両対応）
const browserAPI = (() => {
    if (typeof browser !== 'undefined') {
        // Firefox
        return browser;
    } else if (typeof chrome !== 'undefined') {
        // Chrome - Promiseラッパーを追加
        const chromeAPI = { ...chrome };

        // Chrome APIをPromise化
        if (chrome.storage && chrome.storage.local) {
            chromeAPI.storage = {
                local: {
                    get: (keys) => new Promise(resolve => chrome.storage.local.get(keys, resolve)),
                    set: (items) => new Promise(resolve => chrome.storage.local.set(items, resolve)),
                    remove: (keys) => new Promise(resolve => chrome.storage.local.remove(keys, resolve)),
                    clear: () => new Promise(resolve => chrome.storage.local.clear(resolve)),
                    getBytesInUse: (keys) => new Promise(resolve => chrome.storage.local.getBytesInUse(keys, resolve))
                },
                sync: {
                    get: (keys) => new Promise(resolve => chrome.storage.sync.get(keys, resolve)),
                    set: (items) => new Promise(resolve => chrome.storage.sync.set(items, resolve))
                }
            };
        }

        if (chrome.tabs) {
            chromeAPI.tabs = {
                query: (queryInfo) => new Promise(resolve => chrome.tabs.query(queryInfo, resolve)),
                sendMessage: (tabId, message) => new Promise((resolve, reject) => {
                    chrome.tabs.sendMessage(tabId, message, (response) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(response);
                        }
                    });
                })
            };
        }

        return chromeAPI;
    }

    throw new Error('No browser API available');
})();

// 環境検出
const isFirefox = typeof browser !== 'undefined';
const isChrome = typeof chrome !== 'undefined' && !isFirefox;

// 永続化LRUキャッシュクラス (chrome.storage.local使用)
class PersistentLRUCache {
    constructor(limit = 2000) {
        this.limit = limit;
        this.storage = chrome.storage.local;
        this.cacheKeyPrefix = 'meta_cache_';
        this.metaKey = 'meta_cache_index'; // キー一覧とタイムスタンプを管理
        this.lastCleanUp = 0;

        // メモリ内インデックス: Map<Url, Timestamp>
        // 頻繁なストレージアクセスを減らすため、キーと最終アクセス時刻はメモリにも持つ
        this.index = new Map();

        // initを待機可能にするためPromiseを保持
        this.initPromise = this.init();
    }

    async init() {
        try {
            const result = await this.storage.get(this.metaKey);
            if (result[this.metaKey]) {
                // 配列からMapへ復元: [[url, timestamp], ...]
                this.index = new Map(result[this.metaKey]);
            }
        } catch (e) {
            console.error('Cache init error:', e);
        }
    }

    async saveIndex() {
        try {
            // Mapを配列に変換して保存
            await this.storage.set({ [this.metaKey]: Array.from(this.index.entries()) });
        } catch (e) {
            console.error('Cache index save error:', e);
        }
    }

    async get(url) {
        await this.initPromise;
        if (!this.index.has(url)) return undefined;

        // アクセス日時更新 (メモリ)
        this.index.delete(url);
        this.index.set(url, Date.now());
        // インデックス保存は頻繁すぎるので、一定間隔または重要なタイミングで行うか、
        // ここでは簡易的に都度保存はしない（終了時フックがないので定期保存が理想だが）
        // 今回はset時にまとめて保存する戦略をとる

        const key = this.cacheKeyPrefix + url;
        try {
            const result = await this.storage.get(key);
            return result[key];
        } catch (e) {
            console.error('Cache get error:', e);
            return undefined;
        }
    }

    async set(url, metadata) {
        await this.initPromise;
        const key = this.cacheKeyPrefix + url;
        const timestamp = Date.now();

        // メモリインデックス更新
        if (this.index.has(url)) this.index.delete(url);
        this.index.set(url, timestamp);

        try {
            // ストレージ容量チェック & 掃除
            await this.ensureCapacity();

            await this.storage.set({ [key]: metadata });
            await this.saveIndex();
        } catch (e) {
            console.error('Cache set error:', e);
            // クォータエラーなどが起きた場合、さらに掃除して再試行すべきだが、一旦ログのみ
        }
    }

    async has(url) {
        await this.initPromise;
        return this.index.has(url);
    }

    async clear() {
        await this.initPromise;
        await this.storage.clear();
        this.index.clear();
    }

    async ensureCapacity() {
        // 定期クリーンアップ (例えば set 50回に1回、または容量チェックエラー時)
        // ここでは簡易的に、項目数が limit を超えたら古いものを消す
        if (this.index.size > this.limit) {
            const deleteCount = Math.ceil(this.limit * 0.1); // 10% 削除
            const sorted = Array.from(this.index.entries()).sort((a, b) => a[1] - b[1]); // 古い順

            const keysToRemove = [];
            const urlsToRemove = [];

            for (let i = 0; i < deleteCount; i++) {
                if (i >= sorted.length) break;
                const [url, _] = sorted[i];
                urlsToRemove.push(url);
                keysToRemove.push(this.cacheKeyPrefix + url);
                this.index.delete(url);
            }

            if (keysToRemove.length > 0) {
                console.log(`[Cache] Evicting ${keysToRemove.length} items`);
                await this.storage.remove(keysToRemove);
                // インデックスは saveIndex で更新される
            }
        }

        // 本当は getBytesInUse を見て 4MB 超えたら消す処理も入れたい
        // しかし getBytesInUse は非同期でコストがかかるため、項目数制限をメインガードとする
    }
}

// 永続キャッシュインスタンス
const metadataCache = new PersistentLRUCache(2000);

// Range Request 失敗ドメインリスト (メモリ保持)
const rangeRequestBlockList = new Set();

/**
 * データ管理クラス
 * 全データクリア機能とデータ統計取得を管理
 */
class DataManager {
    /**
     * 全データをクリアする
     * @returns {Promise<Object>} クリア結果
     */
    static async clearAllData() {
        const result = {
            success: true,
            clearedItems: {
                persistentCache: 0,
                rangeBlockList: 0,
                contentScriptCaches: 0
            },
            error: null
        };

        try {
            // 1. PersistentLRUCache のクリア
            const cacheStats = await this.getDataStatistics();
            const cacheItemCount = cacheStats.persistentCache.itemCount;

            await metadataCache.clear();
            result.clearedItems.persistentCache = cacheItemCount;
            debugLog(`[AI Meta Viewer] Cleared ${cacheItemCount} items from PersistentLRUCache`);

            // 2. rangeRequestBlockList のクリア
            const blockListCount = rangeRequestBlockList.size;
            rangeRequestBlockList.clear();
            result.clearedItems.rangeBlockList = blockListCount;
            debugLog(`[AI Meta Viewer] Cleared ${blockListCount} domains from rangeRequestBlockList`);

            // 3. Content Scripts への通知
            const notifiedTabs = await this.notifyContentScripts('clearMemoryCaches');
            result.clearedItems.contentScriptCaches = notifiedTabs;
            debugLog(`[AI Meta Viewer] Notified ${notifiedTabs} content scripts to clear memory caches`);

        } catch (error) {
            result.success = false;
            result.error = error.message;
            debugLog(`[AI Meta Viewer] Data clear error: ${error.message}`);
        }

        return result;
    }

    /**
     * データ統計を取得する
     * @returns {Promise<Object>} データ統計
     */
    static async getDataStatistics() {
        try {
            // PersistentLRUCache の統計
            await metadataCache.initPromise; // 初期化完了を待つ
            const cacheItemCount = metadataCache.index.size;

            // ストレージ使用量を取得
            let storageUsage = 0;
            try {
                const bytesInUse = await chrome.storage.local.getBytesInUse();
                storageUsage = bytesInUse;
            } catch (e) {
                debugLog('[AI Meta Viewer] Could not get storage usage:', e.message);
            }

            // rangeRequestBlockList の統計
            const blockListDomains = Array.from(rangeRequestBlockList);

            return {
                persistentCache: {
                    itemCount: cacheItemCount,
                    storageUsage: storageUsage
                },
                rangeBlockList: {
                    domainCount: blockListDomains.length,
                    domains: blockListDomains
                },
                contentScriptCaches: {
                    metadataCache: 0, // Content Script から取得する必要があるが、今回は簡略化
                    noMetadataCache: 0,
                    localMetadataCache: 0,
                    processedImages: 0
                }
            };
        } catch (error) {
            throw new Error(`Failed to get data statistics: ${error.message}`);
        }
    }

    /**
     * Content Scripts に通知を送信する
     * @param {string} action - 実行するアクション
     * @returns {Promise<number>} 通知されたタブ数
     */
    static async notifyContentScripts(action) {
        try {
            const tabs = await chrome.tabs.query({});
            let notifiedCount = 0;

            for (const tab of tabs) {
                try {
                    await chrome.tabs.sendMessage(tab.id, { action: action });
                    notifiedCount++;
                } catch (e) {
                    // Content Script が読み込まれていないタブは無視
                    debugLog(`[AI Meta Viewer] Could not notify tab ${tab.id}: ${e.message}`);
                }
            }

            return notifiedCount;
        } catch (error) {
            debugLog(`[AI Meta Viewer] Error notifying content scripts: ${error.message}`);
            return 0;
        }
    }
}

/**
 * Civitai.com ドメイン管理クラス
 * Civitai.comドメインの特別処理を管理
 */
class CivitaiDomainManager {
    /**
     * URLがCivitai.comドメインかどうかを判定
     * @param {string} url - 判定するURL
     * @returns {boolean} Civitai.comドメインの場合true
     */
    static isCivitaiDomain(url) {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            return hostname === 'civitai.com' || hostname.endsWith('.civitai.com');
        } catch (e) {
            return false;
        }
    }

    /**
     * ドメインがブロック除外対象かどうかを判定
     * @param {string} domain - 判定するドメイン
     * @returns {boolean} 除外対象の場合true
     */
    static shouldExemptFromBlocking(domain) {
        if (!domain) return false;
        const lowerDomain = domain.toLowerCase();
        return lowerDomain === 'civitai.com' || lowerDomain.endsWith('.civitai.com');
    }

    /**
     * 起動時にrangeRequestBlockListからCivitai.comを削除
     */
    static removeCivitaiFromBlockList() {
        const civitaiDomains = Array.from(rangeRequestBlockList).filter(domain =>
            this.shouldExemptFromBlocking(domain)
        );

        if (civitaiDomains.length > 0) {
            civitaiDomains.forEach(domain => {
                rangeRequestBlockList.delete(domain);
                debugLog(`[AI Meta Viewer] Removed ${domain} from rangeRequestBlockList during startup cleanup`);
            });
            debugLog(`[AI Meta Viewer] Startup cleanup: Removed ${civitaiDomains.length} Civitai domains from block list`);
        }
    }
}


// ダウンロード先パスを一時的に保持するマップ（URL -> ファイルパスのキュー）
const downloadPathQueue = new Map();

// ファイル名の決定を上書きするリスナー
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const queue = downloadPathQueue.get(item.url);
    if (queue && queue.length > 0) {
        const targetFilename = queue.shift();
        if (queue.length === 0) downloadPathQueue.delete(item.url);

        debugLog('[AI Meta Viewer] Forcing filename via Event:', targetFilename);
        suggest({
            filename: targetFilename,
            conflictAction: 'uniquify'
        });
    }
});

// ダウンロード状態の監視 (失敗通知用)
chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state && delta.state.current === 'interrupted') {
        chrome.downloads.search({ id: delta.id }, (items) => {
            if (items && items[0]) {
                const item = items[0];
                const filename = item.filename.split(/[\\/]/).pop();
                const error = item.error || 'Unknown error';
                console.error(`[AI Meta Viewer] Download failed: ${filename}`, error);

                // アクティブなタブに通知を送る
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0]) {
                        chrome.tabs.sendMessage(tabs[0].id, {
                            action: 'showNotification',
                            message: `Download failed: ${filename} (${error})`,
                            type: 'error'
                        }).catch(() => { });
                    }
                });
            }
        });
    }
});

// デフォルト設定
const DEFAULT_SETTINGS = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000,
    downloaderFolderMode: 'pageTitle', // 'pageTitle', 'domain', 'none'
    downloaderBaseFolder: 'AI_Meta_Viewer',
    downloaderUseRoot: false
};

// 現在の設定（起動時に読み込み）
let settings = { ...DEFAULT_SETTINGS };

// デバッグログ出力関数
function debugLog(...args) {
    if (settings.debugMode) {
        console.log(...args);
    }
}

// 設定を読み込む
async function loadSettings() {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    settings = stored;
    debugLog('[AI Meta Viewer] Settings loaded:', settings);
}

// 初期化時に設定を読み込む
loadSettings();

// 起動時のCivitai.comドメインクリーンアップ
CivitaiDomainManager.removeCivitaiFromBlockList();

/**
 * Content Scriptからのメッセージを処理
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchImageMetadata') {
        handleFetchImageMetadata(request.imageUrl, request.imageData)
            .then(sendResponse)
            .catch(error => {
                console.error('Metadata fetch error:', error);
                sendResponse({ success: false, error: error.message });
            });

        // 非同期レスポンスを返すため true を返す
        return true;
    }

    if (request.action === 'settingsUpdated') {
        // 設定が更新された
        settings = request.settings;
        debugLog('[AI Meta Viewer] Settings updated:', settings);
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'clearCache') {
        // キャッシュをクリア
        metadataCache.clear().then(() => {
            debugLog('[AI Meta Viewer] Cache cleared');
            sendResponse({ success: true });
        });
        return true;
    }

    if (request.action === 'clearAllData') {
        // 全データクリア
        DataManager.clearAllData()
            .then(result => {
                debugLog('[AI Meta Viewer] All data cleared:', result);
                sendResponse(result);
            })
            .catch(error => {
                console.error('Clear all data error:', error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }

    if (request.action === 'getDataStatistics') {
        // データ統計取得
        DataManager.getDataStatistics()
            .then(statistics => {
                debugLog('[AI Meta Viewer] Data statistics retrieved:', statistics);
                sendResponse({ success: true, statistics: statistics });
            })
            .catch(error => {
                console.error('Get data statistics error:', error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }

    if (request.action === 'downloadImages') {
        const folderContext = request.context || { folderName: request.folderName };
        handleDownloadImages(request.images, folderContext)
            .then(count => sendResponse({ success: true, count }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (request.action === 'getMediaSize') {
        handleGetMediaSize(request.url)
            .then(sendResponse)
            .catch(error => {
                console.error('Size fetch error:', error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }
});

/**
 * メディアのファイルサイズを取得(HEADリクエスト)
 */
async function handleGetMediaSize(url) {
    try {
        const response = await fetch(url, { method: 'HEAD' });
        if (!response.ok) {
            // HEADが拒否される場合はRangeで1バイトだけ試す
            const rangeResp = await fetch(url, { headers: { 'Range': 'bytes=0-0' } });
            if (!rangeResp.ok) throw new Error(`HTTP ${rangeResp.status}`);

            const size = rangeResp.headers.get('Content-Range')?.split('/')?.[1];
            return { success: true, size: size ? parseInt(size, 10) : null };
        }

        const size = response.headers.get('Content-Length');
        return { success: true, size: size ? parseInt(size, 10) : null };
    } catch (e) {
        return { success: false, error: e.message };
    }
}

/**
 * 拡張機能アイコンがクリックされた時の処理
 */
chrome.action.onClicked.addListener((tab) => {
    debugLog('[AI Meta Viewer] Extension icon clicked on tab:', tab.id);
    chrome.tabs.sendMessage(tab.id, { action: 'triggerScan' }).catch(err => {
        console.error('[AI Meta Viewer] Failed to send triggerScan message:', err);
    });
});

/**
 * 画像リストを一括ダウンロード
 */
async function handleDownloadImages(images, context) {
    const { pageTitle, domain } = context || {};
    debugLog('[AI Meta Viewer] Starting download loop. Images:', images.length);

    // フォルダ・ファイル名に使用できない文字のサニタイズ (Windows/macOS/Linux共通)
    const sanitize = (str) => {
        if (!str) return '';
        return str
            .replace(/[\\/:*?"<>|]/g, '_') // Windows基本禁止文字
            .replace(/^\.+|\.+$/g, '_')    // 先頭・末尾のドットを '_' に (Windowsフォルダ制限)
            .trim();
    };

    let downloadPath = '';
    // ルート保存設定がオフの場合のみメインフォルダを作成
    if (!settings.downloaderUseRoot) {
        const base = sanitize(settings.downloaderBaseFolder || 'AI_Meta_Viewer');
        if (base && base !== '_') {
            downloadPath = base;
        }
    }

    let subFolder = '';

    if (settings.downloaderFolderMode === 'pageTitle' && pageTitle) {
        subFolder = sanitize(pageTitle).substring(0, 22); // ユーザー指定の22文字制限を維持
    } else if (settings.downloaderFolderMode === 'domain' && domain) {
        subFolder = sanitize(domain);
    }

    if (subFolder) {
        if (downloadPath) {
            downloadPath += `/${subFolder}`;
        } else {
            downloadPath = subFolder;
        }
    }

    // どちらも空の場合はファイル名のみ（ダウンロード直下）
    if (!downloadPath) {
        console.log('[AI Meta Viewer] Saving directly to Downloads root');
    } else {
        console.log('[AI Meta Viewer] Final download directory (relative to Downloads):', downloadPath);
    }

    // --- Civitai 特殊処理: safetensors はルート、画像は zip 圧縮 ---
    if (context.isCivitai && images.some(img => img.isCivitaiModel)) {
        return handleCivitaiZipDownload(images, context);
    }

    let downloadedCount = 0;
    for (const img of images) {
        try {
            let safeFilename = sanitize(img.filename);
            if (!safeFilename || safeFilename === '_') {
                safeFilename = `image_${Date.now()}_${downloadedCount}.png`;
            }

            const fullFilename = downloadPath ? `${downloadPath}/${safeFilename}` : safeFilename;
            debugLog('[AI Meta Viewer] Registering path & Requesting download:', fullFilename);

            // イベントリスナー用にキューへパスを登録
            if (!downloadPathQueue.has(img.url)) {
                downloadPathQueue.set(img.url, []);
            }
            downloadPathQueue.get(img.url).push(fullFilename);

            chrome.downloads.download({
                url: img.url,
                filename: fullFilename,
                conflictAction: 'uniquify',
                saveAs: false
            }, (downloadId) => {
                if (chrome.runtime.lastError) {
                    console.error(`[AI Meta Viewer] API Error for ${fullFilename}:`, chrome.runtime.lastError.message);
                    // 失敗した場合はキューから削除を試みる
                    const q = downloadPathQueue.get(img.url);
                    if (q) {
                        q.shift();
                        if (q.length === 0) downloadPathQueue.delete(img.url);
                    }
                } else {
                    debugLog(`[AI Meta Viewer] Download started with ID: ${downloadId}`);
                }
            });

            downloadedCount++;
        } catch (e) {
            console.error(`[AI Meta Viewer] Catch block error for ${img.url}:`, e);
        }
    }

    return downloadedCount;
}

/**
 * Civitai 専用のダウンロード処理
 * safetensors はルート直下へ、画像群は zip に圧縮
 */
async function handleCivitaiZipDownload(images, context) {
    if (typeof JSZip === 'undefined') {
        throw new Error('JSZip library not loaded');
    }

    const modelFiles = images.filter(img => img.isCivitaiModel);
    const galleryImages = images.filter(img => !img.isCivitaiModel);
    const modelName = context.modelName || 'Civitai_Model';

    let downloadedCount = 0;

    const sanitize = (str) => {
        if (!str) return '';
        return str.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+|\.+$/g, '_').trim();
    };

    // 1. モデルファイル (safetensors) のダウンロード (ルート直下)
    for (const model of modelFiles) {
        const safeFilename = sanitize(model.filename);
        // ルートに保存するため、パスはファイル名のみ
        if (!downloadPathQueue.has(model.url)) downloadPathQueue.set(model.url, []);
        downloadPathQueue.get(model.url).push(safeFilename);

        chrome.downloads.download({
            url: model.url,
            filename: safeFilename,
            conflictAction: 'uniquify',
            saveAs: false
        });
        downloadedCount++;
    }

    // 2. 画像群の ZIP 圧縮
    if (galleryImages.length > 0) {
        try {
            const zip = new JSZip();
            const zipFileName = `${sanitize(modelName)}.zip`;

            // 画像を一つずつ取得して ZIP に追加
            for (const img of galleryImages) {
                try {
                    const response = await fetch(img.url);
                    if (response.ok) {
                        const blob = await response.blob();
                        zip.file(sanitize(img.filename), blob);
                    }
                } catch (e) {
                    console.error('[AI Meta Viewer] Failed to fetch image for ZIP:', img.url, e);
                }
            }

            const zipContent = await zip.generateAsync({ type: 'blob' });
            const zipUrl = URL.createObjectURL(zipContent);

            // ZIPをダウンロード
            if (!downloadPathQueue.has(zipUrl)) downloadPathQueue.set(zipUrl, []);
            downloadPathQueue.get(zipUrl).push(zipFileName);

            chrome.downloads.download({
                url: zipUrl,
                filename: zipFileName,
                conflictAction: 'uniquify',
                saveAs: false
            }, () => {
                // ダウンロード開始後に URL を解放 (少し待つ必要があるかもしれないが、通常のAPIなら即座でもいけるはず)
                setTimeout(() => URL.revokeObjectURL(zipUrl), 60000);
            });

            downloadedCount += galleryImages.length;
        } catch (e) {
            console.error('[AI Meta Viewer] ZIP compression error:', e);
            throw e;
        }
    }

    return downloadedCount;
}


/**
 * 画像を取得してメタデータを抽出
 * Adaptive Range Request Logic 実装
 */
async function handleFetchImageMetadata(imageUrl, base64Data = null) {
    debugLog('[AI Meta Viewer] Fetching metadata for:', imageUrl);

    // 1. キャッシュチェック (Async)
    const cachedMetadata = await metadataCache.get(imageUrl);
    const isSafetensorsUrl = imageUrl.toLowerCase().includes('.safetensors') || imageUrl.toLowerCase().includes('format=safetensor');

    if (cachedMetadata !== undefined) {
        // 空のメタデータがキャッシュされているが、Safetensors の場合は最新の取得ロジックを試す価値がある
        if (Object.keys(cachedMetadata).length === 0 && isSafetensorsUrl) {
            debugLog('[AI Meta Viewer] Cached metadata is empty for Safetensors. Bypassing cache to retry with new logic...', imageUrl);
        } else {
            debugLog('[AI Meta Viewer] Persistent Cache hit:', imageUrl);
            return { success: true, metadata: cachedMetadata, cached: true };
        }
    }

    // parser.js チェック
    if (typeof extractMetadata !== 'function') {
        debugLog('[AI Meta Viewer] Error: extractMetadata function not found');
        return { success: false, error: 'Parser not loaded' };
    }

    try {
        let buffer;
        let isRangeRequest = false;

        if (base64Data) {
            // Base64データが提供されている場合（ローカルファイルなど）
            debugLog('[AI Meta Viewer] Using provided Base64 data');
            const response = await fetch(base64Data);
            buffer = await response.arrayBuffer();
        } else {
            // URLフェッチ: Range Request 試行
            // ドメインチェック
            let domain = '';
            try { domain = new URL(imageUrl).hostname; } catch (e) { }

            const shouldUseRange = !rangeRequestBlockList.has(domain);

            if (shouldUseRange) {
                try {
                    // 最初は 64KB をリクエスト。不足分は解析後の isIncomplete ロジックで補填する。
                    const rangeSize = 65535;
                    debugLog(`[AI Meta Viewer] Starting Range request (0-${rangeSize})`);

                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 10000); // 念のため長めの10秒

                    const response = await fetch(imageUrl, {
                        headers: { 'Range': `bytes=0-${rangeSize}` },
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (response.status === 206) {
                        // Range成功
                        isRangeRequest = true;
                        buffer = await response.arrayBuffer();
                        debugLog(`[AI Meta Viewer] Range request success (0-${rangeSize})`);
                    } else if (response.status === 200) {
                        // サーバーがRange無視して全データ返してきた
                        debugLog('[AI Meta Viewer] Server ignored Range, received full content');
                        buffer = await response.arrayBuffer();
                        // ブロックはしない（害はないため）
                    } else {
                        // 403, 400, 416 等 -> Range不可とみなす
                        throw new Error(`Range request failed with status ${response.status}`);
                    }

                } catch (e) {
                    debugLog('[AI Meta Viewer] Range request failed or aborted:', e.message);

                    // Civitai.com ドメインの特別処理: ブロックリストに追加しない
                    if (domain && CivitaiDomainManager.shouldExemptFromBlocking(domain)) {
                        debugLog(`[AI Meta Viewer] Civitai.com domain exempted from blocking: ${domain}. Range Request failure reason: ${e.message}`);
                    } else if (domain) {
                        // 通常のドメインはブロックリストへ追加
                        rangeRequestBlockList.add(domain);
                        debugLog(`[AI Meta Viewer] Added ${domain} to Range Blocklist. Failure reason: ${e.message}`);
                    }

                    // フォールバック: 全取得
                    const fbResponse = await fetch(imageUrl);
                    if (!fbResponse.ok) throw new Error(`Fallback HTTP ${fbResponse.status}`);
                    buffer = await fbResponse.arrayBuffer();
                }
            } else {
                // 最初から Range 不可ドメイン
                debugLog('[AI Meta Viewer] Skipping Range for blocked domain, fetching full...');
                const response = await fetch(imageUrl);
                if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
                buffer = await response.arrayBuffer();
            }
        }

        // --- メタデータ解析 ---
        // Range Requestの場合、ファイルが不完全なので、パーサーがエラーを吐く可能性がある
        // または、末尾にデータがある場合（PNGのtEXtが最後にある、StealthInfoが最後にあるなど）は見逃す

        let metadata = {};
        try {
            metadata = extractMetadata(buffer);

            // メタデータが「不完全（バッファ不足）」と判定された場合のリトライロジック
            if (metadata.isIncomplete && isRangeRequest) {
                const retrySize = metadata.suggestedSize || 131072; // 指定がない場合は 128KB 程度
                debugLog(`[AI Meta Viewer] Metadata is incomplete. Retrying with larger range: 0-${retrySize}`);

                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 10000);

                    const retryResponse = await fetch(imageUrl, {
                        headers: { 'Range': `bytes=0-${retrySize}` },
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (retryResponse.status === 206) {
                        const newBuffer = await retryResponse.arrayBuffer();
                        const nextMetadata = extractMetadata(newBuffer);

                        // 再度不完全と言われたら、流石に効率が悪いので全取得に移行する
                        if (nextMetadata.isIncomplete) {
                            debugLog('[AI Meta Viewer] Still incomplete. Falling back to full fetch.');
                            const fullResp = await fetch(imageUrl);
                            const fullBuffer = await fullResp.arrayBuffer();
                            metadata = extractMetadata(fullBuffer);
                            isRangeRequest = false;
                        } else {
                            metadata = nextMetadata;
                            buffer = newBuffer;
                            debugLog('[AI Meta Viewer] Successfully extracted metadata after larger range fetch');
                        }
                    } else {
                        // Rangeリトライ失敗 -> 全取得
                        const fullResp = await fetch(imageUrl);
                        const fullBuffer = await fullResp.arrayBuffer();
                        metadata = extractMetadata(fullBuffer);
                        isRangeRequest = false;
                    }
                } catch (retryError) {
                    debugLog('[AI Meta Viewer] Range retry failed, falling back to full fetch:', retryError.message);
                    const fullResp = await fetch(imageUrl);
                    const fullBuffer = await fullResp.arrayBuffer();
                    metadata = extractMetadata(fullBuffer);
                    isRangeRequest = false;
                }
            } // Close if (metadata.isIncomplete && isRangeRequest)
        } catch (e) {
            // 解析エラー（JSONパース失敗など）が出た場合、かつRangeRequestだった場合は、不完全データが原因かもしれないので全取得リトライ
            if (isRangeRequest) {
                debugLog('[AI Meta Viewer] Parse error on partial data, retrying full fetch:', e.message);
                try {
                    const fullResp = await fetch(imageUrl);
                    if (fullResp.ok) {
                        const fullBuffer = await fullResp.arrayBuffer();
                        buffer = fullBuffer;
                        metadata = extractMetadata(buffer);
                        isRangeRequest = false;
                    }
                } catch (retryFullErr) {
                    debugLog('[AI Meta Viewer] Full retry fetch failed:', retryFullErr.message);
                }
            } else {
                debugLog('[AI Meta Viewer] Metadata extraction failed on full data:', e.message);
            }
        }

        debugLog('[AI Meta Viewer] Extracted metadata:', metadata);

        // Stealth PNG Info チェック (常に全データが必要)
        // Range Requestで取得した64KBだけでは、画像サイズチェックや画素読み取りができない（不整合が起きる）
        // または、Stealth Infoは画像のピクセルデータ全体に散らばっているため、全取得必須。
        // -> メタデータが見つからず、かつPNGの場合で、Range取得だった場合は、結局全取得が必要になる可能性がある。

        // 戦略:
        // 通常のメタデータがあれば、Stealth Infoは見にいかない（既存ロジック通り）。
        // メタデータが無い場合のみ Stealth Info を見る。
        // -> なので、Rangeでメタデータが見つかれば高速化成功。無ければ全取得してStealthチェックへ。

        if (Object.keys(metadata).length === 0) {
            const format = detectImageFormat(buffer);
            if (format === 'png') {
                // RangeデータだけでStealth解析はできないので、Rangeだった場合は全取得してから挑む
                if (isRangeRequest) {
                    debugLog('[AI Meta Viewer] No standard metadata in partial data. Downloading full image for Stealth Info check...');
                    const fullResp = await fetch(imageUrl);
                    if (fullResp.ok) {
                        buffer = await fullResp.arrayBuffer(); // バッファ置き換え
                    }
                }

                const hasAlpha = checkPngIHDRHasAlpha(buffer);
                if (hasAlpha) {
                    const stealthData = await extractStealthPNGInfoAsync(imageUrl, buffer);
                    if (stealthData) {
                        Object.assign(metadata, stealthData);
                    }
                }
            }
        }

        // Cache Result (Empty or Not)
        // ここで保存。次回からは通信なし。
        await metadataCache.set(imageUrl, metadata);

        return { success: true, metadata: metadata };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Stealth PNG Info を非同期で抽出
 */
async function extractStealthPNGInfoAsync(imageUrl, buffer) {
    try {
        const blob = new Blob([buffer], { type: 'image/png' });
        // createImageBitmap は壊れた（部分的な）PNGデータだと失敗する可能性がある
        const imageBitmap = await createImageBitmap(blob);
        const width = imageBitmap.width;
        const height = imageBitmap.height;

        if (width * height < 250000) {
            imageBitmap.close();
            return null;
        }

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0);

        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        imageBitmap.close();

        // Alphaチャンネルのシグネチャチェック
        const sigLength = 15; // "stealth_pnginfo".length
        const sigBitsNeeded = sigLength * 8;
        let alphaSig = "";
        for (let i = 0; i < sigBitsNeeded; i++) {
            alphaSig += (data[i * 4 + 3] & 1);
        }

        const targetSig = "011100110111010001100101011000010110110001110100011010000101111101110000011011100110011101101001011011100110011001101111";

        if (alphaSig === targetSig) {
            debugLog('[AI Meta Viewer] Alpha signature match! Extracting full data...');
            const totalPixels = width * height;
            const alphaBits = new Uint8Array(totalPixels);

            for (let i = 0; i < totalPixels; i++) {
                alphaBits[i] = data[i * 4 + 3] & 1;
            }

            const bitStreamAlpha = Array.from(alphaBits).join('');
            const resultAlpha = processStealthStream(bitStreamAlpha, 'Alpha');
            if (resultAlpha && resultAlpha.data) {
                return { 'Stealth PNG Info (Alpha)': resultAlpha.data };
            }
        }

        // RGBチェック (省略または必要なら実装、今回はAlphaのみで高速化重視)
        return null;

    } catch (error) {
        // console.error('Stealth PNG Info extraction error:', error);
        return null;
    }
}

// Service Worker起動時にライブラリを読み込む
try {
    importScripts('jszip.min.js');
    console.log('[AI Meta Viewer] JSZip loaded successfully');
} catch (e) {
    console.error('[AI Meta Viewer] Failed to load JSZip:', e);
}

try {
    importScripts('pako.js');
    console.log('[AI Meta Viewer] Pako loaded successfully');
} catch (e) {
    console.error('[AI Meta Viewer] Failed to load Pako:', e);
}

try {
    importScripts('parser.js');
    console.log('[AI Meta Viewer] Parser loaded successfully');
} catch (e) {
    console.error('[AI Meta Viewer] Failed to load Parser:', e);
}

console.log('[AI Meta Viewer] Background service worker loaded with imports');

// Brave ブラウザ対応: Service Worker の keep-alive メカニズム
let keepAliveInterval;

function startKeepAlive() {
    // 25秒ごとにダミーの処理を実行してService Workerを維持
    keepAliveInterval = setInterval(() => {
        console.log('[AI Meta Viewer] Keep-alive ping');
    }, 25000);
}

function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
    }
}

// Service Worker の起動時にkeep-aliveを開始
startKeepAlive();

// Service Worker の動作確認用
console.log('[AI Meta Viewer] Chrome APIs available:', {
    runtime: !!chrome.runtime,
    storage: !!chrome.storage,
    tabs: !!chrome.tabs,
    downloads: !!chrome.downloads
});

console.log('[AI Meta Viewer] Background script initialization complete');

// Brave ブラウザ診断機能
console.log('=== Brave Background Diagnostic ===');
console.log('Chrome APIs in background:', {
    runtime: !!chrome.runtime,
    storage: !!chrome.storage,
    tabs: !!chrome.tabs,
    downloads: !!chrome.downloads,
    action: !!chrome.action
});

// Brave 専用メッセージハンドラー
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'brave_diagnostic_test') {
        console.log('[AI Meta Viewer] Brave diagnostic test message received');
        sendResponse({
            success: true,
            message: 'Background script responding',
            timestamp: Date.now(),
            sender: sender
        });
        return true;
    }
});
