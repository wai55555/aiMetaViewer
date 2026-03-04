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

// 永続化LRUキャッシュクラス (browserAPI.storage.local使用)
class PersistentLRUCache {
    constructor(limit = 2000) {
        this.limit = limit;
        this.byteLimit = 4 * 1024 * 1024; // 4MB ソフトリミット (Quotaは5MB)
        this.storage = browserAPI.storage.local;
        this.cacheKeyPrefix = 'meta_cache_';
        this.metaKey = 'meta_cache_index';
        this.totalBytes = 0; // 推定合計バイト数

        // メモリ内インデックス: Map<Url, { t: timestamp, s: size }>
        this.index = new Map();

        // initを待機可能にするためPromiseを保持
        this.initPromise = this.init();
    }

    async init() {
        try {
            const result = await this.storage.get(this.metaKey);
            if (result[this.metaKey]) {
                // 配列からMapへ復元
                this.index = new Map(result[this.metaKey]);

                // 合計サイズの再計算
                this.totalBytes = 0;
                for (const value of this.index.values()) {
                    // 旧バージョン互換性: 数値(timestamp)だった場合はサイズ0とする
                    this.totalBytes += (typeof value === 'object' ? (value.s || 0) : 0);
                }
            }
        } catch (e) {
            console.error('Cache init error:', e);
        }
    }

    async saveIndex() {
        if (this.saveTimer) clearTimeout(this.saveTimer);

        this.saveTimer = setTimeout(async () => {
            try {
                await this.storage.set({ [this.metaKey]: Array.from(this.index.entries()) });
            } catch (e) {
                console.error('Cache index save error:', e);
            }
        }, 2000);
    }

    async get(url) {
        await this.initPromise;
        const entry = this.index.get(url);
        if (!entry) return undefined;

        // アクセス日時更新 (LRU)
        const size = typeof entry === 'object' ? entry.s : 0;
        this.index.delete(url);
        this.index.set(url, { t: Date.now(), s: size });

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

        // 文字列化した際のおよそのサイズを計算 (簡易的に文字数を使用)
        const size = JSON.stringify(metadata).length;

        // 既存エントリがあればサイズを差し引く
        const oldEntry = this.index.get(url);
        if (oldEntry) {
            this.totalBytes -= (typeof oldEntry === 'object' ? oldEntry.s : 0);
            this.index.delete(url);
        }

        try {
            // ストレージ容量チェック & 掃除
            await this.ensureCapacity(size);

            this.index.set(url, { t: Date.now(), s: size });
            this.totalBytes += size;

            await this.storage.set({ [key]: metadata });
            await this.saveIndex();
        } catch (e) {
            console.error('Cache set error:', e);
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
        this.totalBytes = 0;
    }

    async ensureCapacity(newSize = 0) {
        // 項目数制限 または バイト数制限に抵触する場合
        if (this.index.size >= this.limit || (this.totalBytes + newSize) > this.byteLimit) {
            debugLog(`[Cache] Capacity check: count=${this.index.size}, totalBytes=${this.totalBytes}, adding=${newSize}`);

            // 古い順にソート (t: timestamp が小さい順)
            const sorted = Array.from(this.index.entries())
                .sort((a, b) => {
                    const timeA = typeof a[1] === 'object' ? a[1].t : a[1];
                    const timeB = typeof b[1] === 'object' ? b[1].t : b[1];
                    return timeA - timeB;
                });

            const keysToRemove = [];
            const targetBytes = this.byteLimit * 0.7; // 70%まで空ける
            const targetCount = this.limit * 0.9;     // 90%まで空ける

            for (const [url, value] of sorted) {
                // 削除条件を満たさなくなるまでループ
                if (this.index.size < targetCount && this.totalBytes < targetBytes) break;

                const size = typeof value === 'object' ? (value.s || 0) : 0;
                keysToRemove.push(this.cacheKeyPrefix + url);

                this.totalBytes -= size;
                this.index.delete(url);

                if (keysToRemove.length >= 100) break; // 一度に消しすぎないガード
            }

            if (keysToRemove.length > 0) {
                debugLog(`[Cache] Evicting ${keysToRemove.length} items to free space. Remaining totalBytes=${this.totalBytes}`);
                await this.storage.remove(keysToRemove);
            }
        }
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
            const totalBytes = metadataCache.totalBytes;

            // ストレージ使用量を取得
            let storageUsage = 0;
            try {
                const bytesInUse = await browserAPI.storage.local.getBytesInUse();
                storageUsage = bytesInUse;
            } catch (e) {
                storageUsage = totalBytes; // フォールバック
            }

            // rangeRequestBlockList の統計
            const blockListDomains = Array.from(rangeRequestBlockList);

            return {
                persistentCache: {
                    itemCount: cacheItemCount,
                    totalBytes: totalBytes,
                    byteLimit: metadataCache.byteLimit,
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
            const tabs = await browserAPI.tabs.query({});
            let notifiedCount = 0;

            for (const tab of tabs) {
                try {
                    await browserAPI.tabs.sendMessage(tab.id, { action: action });
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
 * HuggingFace.co ドメイン管理クラス
 * HuggingFace.coドメインの特別処理を管理
 */
class HuggingFaceDomainManager {
    /**
     * URLがHuggingFace.coドメインかどうかを判定
     * @param {string} url - 判定するURL
     * @returns {boolean} HuggingFace.coドメインの場合true
     */
    static isHuggingFaceDomain(url) {
        try {
            const hostname = new URL(url).hostname.toLowerCase();
            return hostname === 'huggingface.co' || hostname.endsWith('.huggingface.co');
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
        return lowerDomain === 'huggingface.co' || lowerDomain.endsWith('.huggingface.co');
    }

    /**
     * 起動時にrangeRequestBlockListからHuggingFace.coを削除
     */
    static removeHuggingFaceFromBlockList() {
        const huggingfaceDomains = Array.from(rangeRequestBlockList).filter(domain =>
            this.shouldExemptFromBlocking(domain)
        );

        if (huggingfaceDomains.length > 0) {
            huggingfaceDomains.forEach(domain => {
                rangeRequestBlockList.delete(domain);
                debugLog(`[AI Meta Viewer] Removed ${domain} from rangeRequestBlockList during startup cleanup`);
            });
            debugLog(`[AI Meta Viewer] Startup cleanup: Removed ${huggingfaceDomains.length} HuggingFace domains from block list`);
        }
    }
}
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

// 全取得（arrayBuffer）の安全上限サイズ (2MB)
// サーバーが Range リクエストを無視して全データを返してきた場合に、
// この上限を超えるファイルのメモリ読み込みを拒否し、Service Worker の
// クラッシュ（メモリ不足）を防ぐ。
// .safetensors のヘッダー取得には先頭 64KB で十分なため、2MB もあれば非常に余裕がある。
const FULL_FETCH_SIZE_LIMIT = 2 * 1024 * 1024; // 2MB

// デフォルト設定
const DEFAULT_SETTINGS = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000,
    downloaderFolderMode: 'id_pageTitle', // 'id_pageTitle', 'pageTitle', 'domain', 'none'
    downloaderBaseFolder: 'AI_Meta_Viewer',
    downloaderUseRoot: false,
    version: '1.4.0'
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

// 起動時のHuggingFace.coドメインクリーンアップ
HuggingFaceDomainManager.removeHuggingFaceFromBlockList();

/**
 * 拡張機能のインストール・アップデート時の処理
 */
chrome.runtime.onInstalled.addListener(async (details) => {
    if (details.reason === 'install') {
        // 新規インストール時はデフォルト設定を書き込む
        await chrome.storage.sync.set(DEFAULT_SETTINGS);
        debugLog('[AI Meta Viewer] Extension installed. Default settings applied.');
    } else if (details.reason === 'update') {
        // アップデート時のマイグレーション
        const stored = await chrome.storage.sync.get(['downloaderFolderMode', 'version']);

        // マイグレーション 1: downloaderFolderMode のアップグレード (pageTitle -> id_pageTitle)
        // ユーザーが以前のデフォルト（pageTitle）のままだった場合、新しい推奨設定（id_pageTitle）へ自動アップグレード
        if (stored.downloaderFolderMode === 'pageTitle') {
            await chrome.storage.sync.set({ downloaderFolderMode: 'id_pageTitle' });
            settings.downloaderFolderMode = 'id_pageTitle'; // メモリ上の設定も更新
            debugLog(`[AI Meta Viewer] Migrated downloaderFolderMode from 'pageTitle' to 'id_pageTitle' (update from ${details.previousVersion})`);
        }

        // 最後に現在のバージョンを記録
        await chrome.storage.sync.set({ version: chrome.runtime.getManifest().version });
    }
});

/**
 * Content Scriptからのメッセージを処理
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // Brave 診断用テスト
    if (request.action === 'brave_diagnostic_test') {
        debugLog('[AI Meta Viewer] Brave diagnostic test message received');
        sendResponse({ success: true, message: 'Brave background alive' });
        return true;
    }

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
    chrome.tabs.sendMessage(tab.id, { action: 'scanPage' }).catch(err => {
        console.error('[AI Meta Viewer] Failed to send scanPage message:', err);
    });
});

/**
 * 画像リストを一括ダウンロード
 */
async function handleDownloadImages(images, context) {
    const { pageTitle, domain } = context || {};
    const pageUrl = context.url || (typeof window !== 'undefined' ? window.location.href : '');
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

    if (settings.downloaderFolderMode === 'id_pageTitle' && pageTitle) {
        // スレッドIDの抽出を試みる (2chan, 5chなど)
        let threadId = '';
        const urlMatch = context.url ? context.url.match(/res\/(\d+)\.htm/) || context.url.match(/test\/read\.cgi\/\w+\/(\d+)/) : null;
        if (urlMatch) {
            threadId = urlMatch[1];
        } else if (pageTitle.match(/^(\d{10})/)) {
            // タイトル先頭が10桁の数字ならそれをIDとする
            threadId = pageTitle.match(/^(\d{10})/)[1];
        }

        const cleanTitle = sanitize(pageTitle).substring(0, 30);
        subFolder = threadId ? `${threadId}_${cleanTitle}` : cleanTitle;
    } else if (settings.downloaderFolderMode === 'pageTitle' && pageTitle) {
        subFolder = sanitize(pageTitle).substring(0, 32);
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
        debugLog('[AI Meta Viewer] Saving directly to Downloads root');
    } else {
        debugLog('[AI Meta Viewer] Final download directory (relative to Downloads):', downloadPath);
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
        let safeFilename = sanitize(model.filename);
        if (!safeFilename || safeFilename === '_') {
            safeFilename = `model_${Date.now()}_${downloadedCount}.safetensors`;
        }
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
        debugLog('[AI Meta Viewer] Cache lookup result:', {
            isSafetensorsUrl: isSafetensorsUrl,
            cachedMetadataKeys: Object.keys(cachedMetadata),
            cachedMetadataLength: Object.keys(cachedMetadata).length,
            cachedMetadata: cachedMetadata
        });

        // 空のメタデータがキャッシュされているが、Safetensors の場合は最新の取得ロジックを試す価値がある
        if (Object.keys(cachedMetadata).length === 0 && isSafetensorsUrl) {
            debugLog('[AI Meta Viewer] Cached metadata is empty for Safetensors. Bypassing cache to retry with new logic...', imageUrl);
        } else {
            debugLog('[AI Meta Viewer] Persistent Cache hit:', imageUrl, 'Keys:', Object.keys(cachedMetadata).join(', '));
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
        let domain = '';
        let totalFileSize = 0; // 追加：Rangeリクエスト時の総サイズ保持
        try { domain = new URL(imageUrl).hostname; } catch (e) { }

        // リダイレクト解決済みのURLを保持
        let activeUrl = imageUrl;

        /**
         * 安全ガード付きの全取得 Fetch
         */
        const safeFetchFull = async (url) => {
            const response = await fetch(url, { redirect: 'follow' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
            if (contentLength > FULL_FETCH_SIZE_LIMIT) {
                if (response.body) response.body.cancel();
                throw new Error(`File size (${contentLength} bytes) exceeds safety limit (${FULL_FETCH_SIZE_LIMIT} bytes).`);
            }

            return await response.arrayBuffer();
        };

        if (base64Data) {
            // Base64データが提供されている場合（ローカルファイルなど）
            debugLog('[AI Meta Viewer] Using provided Base64 data');
            const response = await fetch(base64Data);
            buffer = await response.arrayBuffer();
        } else {
            // URLフェッチ: Range Request 試行
            const shouldUseRange = !rangeRequestBlockList.has(domain);

            if (shouldUseRange) {
                const rangeSize = 65535;
                try {
                    // URL タイプの判定
                    const isCivitaiApiUrl = imageUrl.includes('civitai.com/api/download/models/');
                    const isCloudflareCDN = imageUrl.includes('cloudflarestorage.com');

                    if (isCivitaiApiUrl || isCloudflareCDN) {
                        debugLog('[AI Meta Viewer] Resolving final URL for Range request:', imageUrl.substring(0, 80));
                        try {
                            const headResp = await fetch(imageUrl, { method: 'HEAD', redirect: 'follow' });
                            if (headResp.ok) {
                                activeUrl = headResp.url;
                                debugLog('[AI Meta Viewer] ✓ Final URL resolved:', activeUrl.substring(0, 80));
                            }
                        } catch (headErr) {
                            debugLog('[AI Meta Viewer] ⚠ URL resolution failed, using original:', headErr.message);
                        }
                    }

                    debugLog(`[AI Meta Viewer] Starting Range request (0-${rangeSize}) for:`, activeUrl.substring(0, 80));

                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 10000);

                    const response = await fetch(activeUrl, {
                        headers: { 'Range': `bytes=0-${rangeSize}` },
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (response.status === 206) {
                        isRangeRequest = true;
                        buffer = await response.arrayBuffer(); // 通常の最初のバッファをパース用に割り当て

                        // Content-Range からファイルの総サイズを取得
                        const contentRange = response.headers.get('Content-Range');
                        if (contentRange) {
                            const match = contentRange.match(/\/(\d+)/);
                            if (match) {
                                totalFileSize = parseInt(match[1], 10);
                                debugLog(`[AI Meta Viewer] Content total size: ${totalFileSize} bytes`);
                            }
                        }
                    } else if (response.status === 200) {
                        // サーバーがRangeを無視した場合
                        const contentLength = parseInt(response.headers.get('Content-Length') || '0', 10);
                        if (contentLength > FULL_FETCH_SIZE_LIMIT) {
                            if (response.body) response.body.cancel();
                            throw new Error(`Full content returned but exceeds limit: ${contentLength} bytes`);
                        }
                        buffer = await response.arrayBuffer();
                        totalFileSize = buffer.byteLength;
                    } else {
                        throw new Error(`Range request failed with status ${response.status}`);
                    }

                } catch (e) {
                    debugLog('[AI Meta Viewer] Range request failed, falling back to safe full fetch:', e.message);
                    if (domain && !CivitaiDomainManager.shouldExemptFromBlocking(domain) && !HuggingFaceDomainManager.shouldExemptFromBlocking(domain)) {
                        rangeRequestBlockList.add(domain);
                    }
                    buffer = await safeFetchFull(imageUrl);
                }
            } else {
                debugLog('[AI Meta Viewer] Skipping Range for blocked domain, fetching full...', domain);
                buffer = await safeFetchFull(imageUrl);
            }
        }

        // --- メタデータ解析 ---
        let metadata = {};
        try {
            metadata = extractMetadata(buffer);

            // メタデータ不足時の再試行ロジック
            if (metadata.isIncomplete && isRangeRequest) {

                // ComfyUI (PNGの末尾にメタデータがあるパターン)
                if (metadata.requiresTailFetch && totalFileSize > 65535) {
                    const tailSize = 131072; // 末尾 128KB 取得
                    let tailStart = totalFileSize - tailSize;
                    if (tailStart < 65536) tailStart = 65536; // 既取得分と被らないように

                    debugLog(`[AI Meta Viewer] ⚠ ComfyUI signature detected. Fetching tail for metadata: bytes=${tailStart}-`);
                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 10000);
                        const tailResponse = await fetch(activeUrl, {
                            headers: { 'Range': `bytes=${tailStart}-` },
                            signal: controller.signal
                        });
                        clearTimeout(timeoutId);

                        if (tailResponse.status === 206 || tailResponse.status === 200) {
                            const tailBuffer = await tailResponse.arrayBuffer();

                            // 画像形式に応じて適切な末尾解析器を呼び出す
                            const format = detectImageFormat(buffer);
                            let tailMetadata = {};

                            if (format === 'png') {
                                tailMetadata = extractPngTailMetadata(tailBuffer);
                            } else if (format === 'webp') {
                                tailMetadata = extractWebpTailMetadata(tailBuffer);
                            }

                            const foundKeys = Object.keys(tailMetadata);
                            if (foundKeys.length > 0) {
                                debugLog(`[AI Meta Viewer] ✅ Tail meta found: ${foundKeys.join(', ')}`);
                                Object.assign(metadata, tailMetadata);
                            } else {
                                debugLog('[AI Meta Viewer] ⚠ Tail Range fetched but no metadata found in tail.');
                            }

                            // フラグクリア
                            delete metadata.isIncomplete;
                            delete metadata.requiresTailFetch;
                        } else {
                            debugLog(`[AI Meta Viewer] ⚠ Tail Range failed (Status: ${tailResponse.status}), giving up.`);
                        }
                        isRangeRequest = false; // これ以上のフェッチを防ぐ
                    } catch (tailError) {
                        debugLog('[AI Meta Viewer] ⚠ Tail Range threw error:', tailError.message);
                        isRangeRequest = false;
                    }
                }
                // 通常の再試行 (Safetensorsなど、前方をもっと読む)
                else {
                    const retrySize = metadata.suggestedSize || 131072;
                    debugLog(`[AI Meta Viewer] ⚠ Metadata is incomplete. Retrying with larger range: 0-${retrySize}`);

                    try {
                        const controller = new AbortController();
                        const timeoutId = setTimeout(() => controller.abort(), 10000);
                        const retryResponse = await fetch(activeUrl, {
                            headers: { 'Range': `bytes=0-${retrySize}` },
                            signal: controller.signal
                        });
                        clearTimeout(timeoutId);

                        if (retryResponse.status === 206) {
                            const newBuffer = await retryResponse.arrayBuffer();
                            const nextMetadata = extractMetadata(newBuffer);
                            if (nextMetadata.isIncomplete) {
                                debugLog('[AI Meta Viewer] ⚠ Still incomplete. Falling back to safe full fetch.');
                                const fullBuffer = await safeFetchFull(activeUrl);
                                metadata = extractMetadata(fullBuffer);
                            } else {
                                metadata = nextMetadata;
                                buffer = newBuffer;
                            }
                        } else {
                            debugLog('[AI Meta Viewer] ⚠ Retry Range failed, falling back to safe full fetch.');
                            const fullBuffer = await safeFetchFull(activeUrl);
                            metadata = extractMetadata(fullBuffer);
                        }
                        isRangeRequest = false;
                    } catch (retryError) {
                        debugLog('[AI Meta Viewer] ⚠ Range retry failed, final attempt with safe full fetch:', retryError.message);
                        const fullBuffer = await safeFetchFull(activeUrl);
                        metadata = extractMetadata(fullBuffer);
                        isRangeRequest = false;
                    }
                }
            }
        } catch (e) {
            debugLog('[AI Meta Viewer] Parse failed, trying safe full fetch fallback:', e.message);
            if (isRangeRequest) {
                const fullBuffer = await safeFetchFull(activeUrl);
                buffer = fullBuffer;
                metadata = extractMetadata(buffer);
                isRangeRequest = false;
            } else {
                throw e;
            }
        }

        // Stealth PNG Info チェック
        if (Object.keys(metadata).length === 0) {
            const format = detectImageFormat(buffer);
            if (format === 'png') {
                if (isRangeRequest) {
                    buffer = await safeFetchFull(activeUrl);
                }
                const hasAlpha = checkPngIHDRHasAlpha(buffer);
                if (hasAlpha) {
                    const stealthData = await extractStealthPNGInfoAsync(imageUrl, buffer);
                    if (stealthData) Object.assign(metadata, stealthData);
                }
            }
        }

        await metadataCache.set(imageUrl, metadata);
        return { success: true, metadata: metadata };

    } catch (error) {
        debugLog('[AI Meta Viewer] handleFetchImageMetadata error:', error.message);
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
    debugLog('[AI Meta Viewer] JSZip loaded successfully');
} catch (e) {
    console.error('[AI Meta Viewer] Failed to load JSZip:', e);
}

try {
    importScripts('pako.js');
    debugLog('[AI Meta Viewer] Pako loaded successfully');
} catch (e) {
    console.error('[AI Meta Viewer] Failed to load Pako:', e);
}

try {
    importScripts('parser.js');
    debugLog('[AI Meta Viewer] Parser loaded successfully');
} catch (e) {
    console.error('[AI Meta Viewer] Failed to load Parser:', e);
}

debugLog('[AI Meta Viewer] Background service worker loaded with imports');

// Brave ブラウザ対応: Service Worker の keep-alive メカニズム
let keepAliveInterval;

function startKeepAlive() {
    // 25秒ごとにダミーの処理を実行してService Workerを維持
    keepAliveInterval = setInterval(() => {
        debugLog('[AI Meta Viewer] Keep-alive ping');
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
debugLog('[AI Meta Viewer] Chrome APIs available:', {
    runtime: !!chrome.runtime,
    storage: !!chrome.storage,
    tabs: !!chrome.tabs,
    downloads: !!chrome.downloads,
    action: !!chrome.action
});
debugLog('[AI Meta Viewer] Background script initialization complete');

// Brave ブラウザ診断機能
debugLog('=== Brave Background Diagnostic ===');
debugLog('Chrome APIs in background:', {
    runtime: !!chrome.runtime,
    storage: !!chrome.storage,
    tabs: !!chrome.tabs,
    downloads: !!chrome.downloads,
    action: !!chrome.action
});

