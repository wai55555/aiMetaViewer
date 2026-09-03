// background.js - Universal Background Script (Chrome & Firefox)
const INITIALIZATION_STATES = Object.freeze({
    PENDING: 'pending',
    READY: 'ready',
    FATAL: 'fatal',
});
const SAFE_DIAGNOSTIC_MAX_LENGTH = 240;
const SAFE_CATEGORIES = Object.freeze([
    'acquisition', 'file-access', 'representation-mismatch', 'resource-limit',
    'scanner-failure', 'cancelled', 'cache', 'download', 'fatal-initialization', 'message',
    'parser', 'scanner', 'settings', 'storage', 'unknown',
]);
const SAFE_PHASES = Object.freeze([
    'background', 'content', 'download', 'initialization', 'settings', 'acquisition', 'scanner', 'unknown',
]);
const SAFE_ERROR_TYPES = Object.freeze([
    'abort', 'import', 'invalid-response', 'network', 'storage', 'timeout', 'unknown',
]);
const SAFE_SCHEMES = Object.freeze(['file', 'http', 'https', 'blob']);
const SAFE_SCANNER_STATUSES = Object.freeze([
    'complete', 'empty-confirmed', 'found', 'invalid-png', 'not-found',
    'partial', 'unresolved', 'unsupported-format', 'resource-limit',
    'scanner-failure', 'cancelled', 'unknown',
]);

let initializationState = INITIALIZATION_STATES.PENDING;
let fatalInitializationSignalEmitted = false;
let settings = { debugMode: false };

function getSafeEnum(value, allowedValues) {
    return allowedValues.includes(value) ? value : 'unknown';
}

function inferSafeCategory(value) {
    if (typeof value !== 'string') return 'unknown';
    const lowerValue = value.toLowerCase();
    if (lowerValue.includes('fatal') || lowerValue.includes('import script')) {
        return 'fatal-initialization';
    }
    if (lowerValue.includes('cache')) return 'cache';
    if (lowerValue.includes('storage')) return 'storage';
    if (lowerValue.includes('setting')) return 'settings';
    if (lowerValue.includes('download')) return 'download';
    if (lowerValue.includes('message') || lowerValue.includes('notify')) return 'message';
    if (lowerValue.includes('scan')) return 'scanner';
    if (lowerValue.includes('parse') || lowerValue.includes('metadata')) return 'parser';
    if (lowerValue.includes('fetch') || lowerValue.includes('range') || lowerValue.includes('network')) {
        return 'acquisition';
    }
    return 'unknown';
}

function inferSafeErrorType(value) {
    if (typeof value !== 'string') return 'unknown';
    const lowerValue = value.toLowerCase();
    if (lowerValue.includes('timeout') || lowerValue.includes('stall')) return 'timeout';
    if (lowerValue.includes('abort')) return 'abort';
    if (lowerValue.includes('import')) return 'import';
    if (lowerValue.includes('storage') || lowerValue.includes('quota')) return 'storage';
    if (lowerValue.includes('network') || lowerValue.includes('fetch')) return 'network';
    if (lowerValue.includes('invalid') || lowerValue.includes('response')) return 'invalid-response';
    return 'unknown';
}

function getSafeScheme(value) {
    try {
        const protocol = typeof value === 'string'
            ? new URL(value).protocol
            : value?.protocol;
        const scheme = typeof protocol === 'string' ? protocol.replace(/:$/, '').toLowerCase() : '';
        return SAFE_SCHEMES.includes(scheme) ? scheme : undefined;
    } catch (error) {
        return undefined;
    }
}

function applySafeDiagnosticObject(diagnostic, value) {
    if (value === null || typeof value !== 'object') return;

    try {
        if (value instanceof Error || typeof value.name === 'string') {
            diagnostic.errorType = inferSafeErrorType(value.name);
        }
        const safeKeys = ['category', 'phase', 'status', 'bodyPresent', 'scannerStatus', 'retryable'];
        for (const key of safeKeys) {
            if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
            const entry = value[key];
            if (key === 'category') diagnostic.category = getSafeEnum(entry, SAFE_CATEGORIES);
            if (key === 'phase') diagnostic.phase = getSafeEnum(entry, SAFE_PHASES);
            if (key === 'status' && Number.isInteger(entry) && entry >= 100 && entry <= 599) {
                diagnostic.status = entry;
            }
            if (key === 'bodyPresent' && typeof entry === 'boolean') diagnostic.bodyPresent = entry;
            if (key === 'retryable' && typeof entry === 'boolean') diagnostic.retryable = entry;
            if (key === 'scannerStatus') {
                diagnostic.scannerStatus = getSafeEnum(entry, SAFE_SCANNER_STATUSES);
            }
        }
        const scheme = getSafeScheme(value.url || value);
        if (scheme) diagnostic.scheme = scheme;
        if (typeof value.errorType === 'string') {
            diagnostic.errorType = getSafeEnum(value.errorType, SAFE_ERROR_TYPES);
        }
        if (typeof value.errorName === 'string') {
            diagnostic.errorType = inferSafeErrorType(value.errorName);
        }
        if (value.error && typeof value.error === 'object') {
            applySafeDiagnosticObject(diagnostic, value.error);
        }
    } catch (error) {
        // 異常なgetterやProxyは展開せず、固定のunknownへ落とす。
        diagnostic.errorType = 'unknown';
    }
}

function toSafeDiagnostic(...args) {
    const diagnostic = {
        category: 'unknown',
        phase: 'background',
        errorType: 'unknown',
        redacted: true,
    };

    for (const value of args) {
        if (typeof value === 'string') {
            const category = inferSafeCategory(value);
            if (category !== 'unknown') diagnostic.category = category;
            const errorType = inferSafeErrorType(value);
            if (errorType !== 'unknown') diagnostic.errorType = errorType;
            const scheme = getSafeScheme(value);
            if (scheme) diagnostic.scheme = scheme;
        } else if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) {
            diagnostic.status = value;
        } else {
            applySafeDiagnosticObject(diagnostic, value);
        }
    }

    diagnostic.category = getSafeEnum(diagnostic.category, SAFE_CATEGORIES);
    diagnostic.phase = getSafeEnum(diagnostic.phase, SAFE_PHASES);
    diagnostic.errorType = getSafeEnum(diagnostic.errorType, SAFE_ERROR_TYPES);
    return diagnostic;
}

function formatSafeDiagnostic(diagnostic) {
    const fields = [
        ['category', getSafeEnum(diagnostic?.category, SAFE_CATEGORIES)],
        ['phase', getSafeEnum(diagnostic?.phase, SAFE_PHASES)],
        ['errorType', getSafeEnum(diagnostic?.errorType, SAFE_ERROR_TYPES)],
        ['status', Number.isInteger(diagnostic?.status) ? diagnostic.status : undefined],
        ['bodyPresent', typeof diagnostic?.bodyPresent === 'boolean' ? diagnostic.bodyPresent : undefined],
        ['scannerStatus', getSafeEnum(diagnostic?.scannerStatus, SAFE_SCANNER_STATUSES)],
        ['retryable', typeof diagnostic?.retryable === 'boolean' ? diagnostic.retryable : undefined],
        ['scheme', getSafeEnum(diagnostic?.scheme, SAFE_SCHEMES)],
        ['redacted', true],
    ];
    return fields
        .filter(([, value]) => value !== undefined && value !== 'unknown')
        .map(([key, value]) => `${key}=${value}`)
        .join(' ')
        .slice(0, SAFE_DIAGNOSTIC_MAX_LENGTH);
}

function debugLog(...args) {
    if (settings?.debugMode !== true) return;
    console.log(formatSafeDiagnostic(toSafeDiagnostic(...args)));
}

function emitFatalInitializationFailure() {
    if (fatalInitializationSignalEmitted) return;
    initializationState = INITIALIZATION_STATES.FATAL;
    fatalInitializationSignalEmitted = true;
    const diagnostic = {
        category: 'fatal-initialization',
        phase: 'initialization',
        errorType: 'import',
        retryable: false,
        redacted: true,
    };
    console.error(`[AI Meta Viewer] ${formatSafeDiagnostic(diagnostic)}`);
}

function createInitializationUnavailableResult() {
    return {
        success: false,
        error: 'Background initialization unavailable.',
        diagnostics: {
            category: 'fatal-initialization',
            phase: 'initialization',
            errorType: 'import',
            retryable: false,
            redacted: true,
        },
    };
}

try {
    importScripts('pako.js', 'jszip.min.js', 'parser.js', 'png_metadata_scanner.js');
    initializationState = INITIALIZATION_STATES.READY;
} catch (error) {
    emitFatalInitializationFailure();
}

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
const PNG_SCANNER_CACHE_VERSION = 'png-scanner-v1';
const CACHE_ENTRY_MARKER = 'aiMetaViewerCacheEntry';

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
            debugLog('Cache init error', e);
        }
    }

    async saveIndex() {
        if (this.saveTimer) clearTimeout(this.saveTimer);

        this.saveTimer = setTimeout(async () => {
            try {
                await this.storage.set({ [this.metaKey]: Array.from(this.index.entries()) });
            } catch (e) {
                debugLog('Cache index save error', e);
            }
        }, 500); // R1-c: デバウンス短縮（2000ms→500ms）でonSuspend前に保存される確率を向上
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
            const cachedValue = result[key];
            if (cachedValue && typeof cachedValue === 'object' && cachedValue[CACHE_ENTRY_MARKER] === true) {
                if (cachedValue.scannerVersion && cachedValue.scannerVersion !== PNG_SCANNER_CACHE_VERSION) return undefined;
                if (cachedValue.parserVersion && cachedValue.parserVersion !== PARSER_CACHE_VERSION) return undefined;
                const metadata = cachedValue.metadata;
                if (metadata && typeof metadata === 'object' && cachedValue.parserState) {
                    Object.defineProperty(metadata, 'cacheEntryState', {
                        value: cachedValue.parserState,
                        enumerable: false,
                        configurable: true,
                    });
                }
                return metadata;
            }
            if (cachedValue && typeof cachedValue === 'object' &&
                !Array.isArray(cachedValue) && Object.keys(cachedValue).length === 0) {
                return undefined;
            }
            return cachedValue;
        } catch (e) {
            debugLog('Cache get error', e);
            return undefined;
        }
    }

    async set(url, metadata, options = {}) {
        await this.initPromise;
        const key = this.cacheKeyPrefix + url;

        // JSON文字列をUTF-8へ変換した実byte数をキャッシュ容量として扱う。
        const serialized = JSON.stringify(metadata);
        const size = new TextEncoder().encode(serialized).byteLength;

        // 【修正】単体で制限サイズを超える巨大なメタデータはキャッシュしない
        if (size > this.byteLimit) {
            debugLog(`[Cache] Metadata size (${size}) exceeds byteLimit (${this.byteLimit}). Skipping cache.`);
            return { stored: false, reason: 'size-limit', limit: this.byteLimit, observed: size };
        }

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
            const cacheValue = options.scannerVersion || options.parserVersion || options.parserState
                ? {
                    [CACHE_ENTRY_MARKER]: true,
                    ...(options.scannerVersion ? { scannerVersion: options.scannerVersion } : {}),
                    ...(options.parserVersion ? { parserVersion: options.parserVersion } : {}),
                    ...(options.parserState ? { parserState: options.parserState } : {}),
                    metadata,
                }
                : metadata;
            await this.storage.set({ [key]: cacheValue });
            await this.saveIndex();
            return { stored: true };
        } catch (e) {
            debugLog('Cache set error', e);
            return { stored: false, reason: 'storage-error' };
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
            debugLog('[AI Meta Viewer] Clearing rangeRequestBlockList:', {
                count: blockListCount
            });
            rangeRequestBlockList.clear();
            result.clearedItems.rangeBlockList = blockListCount;
            debugLog('[AI Meta Viewer] Cleared rangeRequestBlockList:', {
                count: blockListCount
            });

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
                debugLog('[AI Meta Viewer] Civitai block-list exemption applied during startup cleanup:', {
                    domain,
                    reason: 'civitai.com domains must never be blocked for Range Request failures'
                });
            });
            debugLog('[AI Meta Viewer] Startup cleanup removed Civitai domains from rangeRequestBlockList:', civitaiDomains);
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

const DOWNLOAD_NOTIFICATION_FILENAME_MAX_LENGTH = 80;

function getSafeDownloadNotificationFilename(value) {
    if (typeof value !== 'string' || /^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
        return 'file';
    }

    const basename = value.split(/[\\/]/).pop() || '';
    const safeBasename = basename
        .split(/[?#]/, 1)[0]
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .trim()
        .slice(0, DOWNLOAD_NOTIFICATION_FILENAME_MAX_LENGTH);

    return safeBasename || 'file';
}

// ダウンロード状態の監視 (失敗通知用)
chrome.downloads.onChanged.addListener((delta) => {
    if (delta.state && delta.state.current === 'interrupted') {
        chrome.downloads.search({ id: delta.id }, (items) => {
            if (items && items[0]) {
                const item = items[0];
                const filename = getSafeDownloadNotificationFilename(item.filename);
                const diagnostic = {
                    category: 'download',
                    phase: 'download',
                    errorType: inferSafeErrorType(item.error)
                };

                // アクティブなタブに通知を送る。診断ログとは独立して実行する。
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs[0]) {
                        chrome.tabs.sendMessage(tabs[0].id, {
                            action: 'showNotification',
                            message: `Download failed: ${filename}`,
                            type: 'error'
                        }).catch(() => { });
                    }
                });

                // 通知には診断情報やraw errorを渡さない。
                debugLog('[AI Meta Viewer] Download failed', diagnostic);
            }
        });
    }
});

// 未知形式またはstreamを持たない環境に対するarrayBufferの安全上限 (2MiB)。
// JPEG、AVIF、WebP、Safetensorsは形式別head budgetを優先し、
// PNGはこの上限を適用せずscannerの集約gateで同時性を制御する。
const FULL_FETCH_SIZE_LIMIT = 2 * 1024 * 1024; // 2MiB
// bodyなしResponseはarrayBuffer全量取得しかできないため、既知長のfallbackだけ許可する。
const BODYLESS_PNG_FALLBACK_LIMIT = 16 * 1024 * 1024; // 16MiB
const FILE_BODYLESS_FALLBACK_LIMIT = 16 * 1024 * 1024; // 16MiB
const RANGE_REQUEST_TIMEOUT_MS = 10000; // Range取得の本文読み込みを含むタイムアウト
const HTTP_OK_STATUS = 200;
const HTTP_PARTIAL_CONTENT_STATUS = 206;

// --- 解析の集約予算 ---
const PARSER_CACHE_VERSION = 'parser-v1';
// PNGの単一ファイルサイズ上限は撤廃したままにする。制御対象は同時性である。
// content script は複数frame・複数tabから要求を送るため、Service Worker が
// 唯一の集約点となる。以下の上限は必ずここで適用する。

// metadata head (初期Range 64KB) の同時取得数。
// 64KiB × 4 = 256KiB。全body stream 2本と合わせて同一ホストへ同時6要求となり、
// HTTP/1.1 における Chrome の同一ホスト接続上限と一致する。
const MAX_CONCURRENT_METADATA_HEAD_FETCHES = 4;

// 全body stream (byte 0 からのPNG再取得) の同時本数。
// guard上限に張り付いた最悪ケースは1本あたり約28MiB (Stealth圧縮8MiB +
// 展開8MiB + text chunk 8MiB + row 2MiB + packed buffer 約1.9MiB) であり、
// 2本で約56MiB に収まる。4096²の典型ケースでは1本約650KiB。
const MAX_CONCURRENT_PNG_FULL_STREAMS = 2;

// 全body stream の in-flight 転送量予算。
// 4K PNG の典型 10〜40MB なら2本、100MB級は自動的に1本へ縮退させる逓減装置。
const PNG_FULL_STREAM_INFLIGHT_BUDGET_BYTES = 64 * 1024 * 1024;

// Content-Range の total が不明なときに仮計上するサイズ。
const PNG_FULL_STREAM_UNKNOWN_SIZE_CHARGE_BYTES = 32 * 1024 * 1024;

// 全body stream の停滞タイムアウト。
// 経過時間ではなく read pending 時間に適用する。40MB を 5MB/s で引くと
// 8秒かかるため、総時間タイムアウトでは正常な大容量取得を殺してしまう。
const PNG_STREAM_STALL_TIMEOUT_MS = 15000;

// 解析要求の優先度。hover は待たせない。
const ANALYSIS_PRIORITY_BATCH = 0;
const ANALYSIS_PRIORITY_VIEWPORT = 1;
const ANALYSIS_PRIORITY_HOVER = 2;

// 待機列の取り出し順。viewport 由来は LIFO、明示スキャンは FIFO。
const ANALYSIS_ORDER_LIFO = 'lifo';
const ANALYSIS_ORDER_FIFO = 'fifo';

/**
 * Content-Range ヘッダを解析する。
 * RFC 7233 は complete-length 不明時の `*` を許容するため、`total` は null を取り得る。
 * `total === null` は「表現全体かどうか判定不能」を意味し、partial として扱う。
 * @param {string|null} value - Content-Range ヘッダ値
 * @returns {{start: number, end: number, total: number|null, length: number}|null}
 */
function parseContentRangeHeader(value) {
    if (typeof value !== 'string') return null;
    const match = value.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start) {
        return null;
    }
    if (match[3] === '*') {
        return { start, end, total: null, length: end - start + 1 };
    }
    const total = Number(match[3]);
    if (!Number.isSafeInteger(total) || total <= end) {
        return null;
    }
    return { start, end, total, length: end - start + 1 };
}

/**
 * 同時実行を有界化するゲート。
 * 本数上限と in-flight byte 予算の両方を見る。予算を超えた要求は拒否せず
 * 順番待ちにする。単独で予算を超える要求は、他に走っているものが無いときに
 * 限り単独実行する。これによりPNGの単一ファイル上限撤廃を維持する。
 */
class ConcurrencyGate {
    /**
     * @param {Object} config
     * @param {string} config.name - 診断用の名前
     * @param {number} config.maxConcurrent - 同時実行数の上限
     * @param {number} [config.budgetBytes] - in-flight byte 予算
     */
    constructor({ name, maxConcurrent, budgetBytes = Number.POSITIVE_INFINITY }) {
        this.name = name;
        this.maxConcurrent = maxConcurrent;
        this.budgetBytes = budgetBytes;
        this.active = 0;
        this.inflightBytes = 0;
        this.waiters = [];
        this.sequence = 0;
        // tab 単位の round-robin 用。1つのtabの大量要求が他tabを枯渇させない。
        this.tabLastServed = new Map();
    }

    /**
     * 待機中の要求を受け入れられるか判定する
     * @param {Object} waiter - 待機エントリ
     * @returns {boolean}
     */
    canAdmit(waiter) {
        if (this.active >= this.maxConcurrent) return false;
        if (this.active === 0) return true; // 単独実行なら予算超過でも許可する
        return this.inflightBytes + waiter.charge <= this.budgetBytes;
    }

    /**
     * 次に実行する待機エントリの位置を選ぶ。
     * priority 降順 → tab round-robin → order (LIFO/FIFO) の順で比較する。
     * @returns {number} - 見つからない場合 -1
     */
    pickWaiterIndex() {
        let bestIndex = -1;
        let bestKey = null;
        for (let index = 0; index < this.waiters.length; index += 1) {
            const waiter = this.waiters[index];
            if (!this.canAdmit(waiter)) continue;
            const tabKey = waiter.tabId === null ? 'none' : waiter.tabId;
            const key = [
                -waiter.getPriority(),
                this.tabLastServed.get(tabKey) || 0,
                waiter.order === ANALYSIS_ORDER_LIFO ? -waiter.sequence : waiter.sequence,
            ];
            if (bestKey === null || ConcurrencyGate.compareKeys(key, bestKey) < 0) {
                bestIndex = index;
                bestKey = key;
            }
        }
        return bestIndex;
    }

    /**
     * 比較キーの辞書順比較
     * @param {number[]} left
     * @param {number[]} right
     * @returns {number}
     */
    static compareKeys(left, right) {
        for (let index = 0; index < left.length; index += 1) {
            if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
        }
        return 0;
    }

    /** 待機列から実行可能なものを可能な限り起動する */
    drain() {
        while (this.waiters.length > 0) {
            const index = this.pickWaiterIndex();
            if (index < 0) return;
            const [waiter] = this.waiters.splice(index, 1);
            this.start(waiter);
        }
    }

    /**
     * 実行枠を確保した状態にする
     * @param {Object} waiter - 待機エントリ
     */
    start(waiter) {
        this.active += 1;
        this.inflightBytes += waiter.charge;
        // 実行枠へ入った待機者はabort listenerの所有を終える。
        if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener('abort', waiter.onAbort);
            waiter.onAbort = null;
        }
        const tabKey = waiter.tabId === null ? 'none' : waiter.tabId;
        this.sequence += 1;
        this.tabLastServed.set(tabKey, this.sequence);
        waiter.resolve(() => this.release(waiter));
    }

    /**
     * 実行枠を返却する。多重呼び出しは無視する。
     * @param {Object} waiter - 待機エントリ
     */
    release(waiter) {
        if (waiter.released) return;
        waiter.released = true;
        this.active -= 1;
        this.inflightBytes -= waiter.charge;
        if (this.inflightBytes < 0) this.inflightBytes = 0;
        this.drain();
    }

    /**
     * 実行枠を取得する。取得できるまで待機する。
     * @param {Object} [options]
     * @param {number} [options.charge] - in-flight byte として計上する量
     * @param {number} [options.priority] - 優先度
     * @param {number|null} [options.tabId] - 要求元 tab
     * @param {string} [options.order] - LIFO / FIFO
     * @param {AbortSignal|null} [options.signal] - 待機中の取り消し用
     * @returns {Promise<Function>} - 実行枠を返却する関数
     */
    acquire({ charge = 0, priority = ANALYSIS_PRIORITY_BATCH, tabId = null,
        order = ANALYSIS_ORDER_FIFO, signal = null } = {}) {
        this.sequence += 1;
        const waiter = {
            charge,
            priority: typeof priority === 'function' ? priority() : priority,
            getPriority: typeof priority === 'function' ? priority : () => priority,
            tabId, order, signal,
            sequence: this.sequence,
            released: false,
            resolve: null,
            reject: null,
        };
        return new Promise((resolve, reject) => {
            waiter.resolve = resolve;
            waiter.reject = reject;

            if (signal) {
                if (signal.aborted) {
                    reject(createAnalysisAbortError());
                    return;
                }
                // 待機中に取り消されたら枠を消費せずに離脱する
                waiter.onAbort = () => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0) {
                        this.waiters.splice(index, 1);
                        reject(createAnalysisAbortError());
                    }
                };
                signal.addEventListener('abort', waiter.onAbort, { once: true });
            }

            if (this.canAdmit(waiter) && this.waiters.length === 0) {
                this.start(waiter);
                return;
            }
            this.waiters.push(waiter);
            this.drain();
        });
    }
}

/**
 * abort 由来の失敗を識別できる error を生成する。
 * abort 結果を success や not-found へ変換しないために名前を固定する。
 * @param {string} [message]
 * @returns {Error}
 */
function createAnalysisAbortError(message = 'Image metadata analysis was aborted.') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

/**
 * 全body stream を停滞タイムアウト付きに包む。
 * 経過時間ではなく read pending 時間に適用するため、低速回線でも
 * 正常な大容量取得を打ち切らない。
 * @param {Object} body - getReader() を持つ stream
 * @param {Function} onStall - 停滞時のコールバック
 * @returns {Object} - stream 互換オブジェクト
 */
function withStallTimeout(body, onStall, signal = null) {
    let activeReader = null;
    let readerCancelled = false;
    let readerReleased = false;
    let abortListener = null;
    const cancelReader = async (reason) => {
        if (readerCancelled) return;
        readerCancelled = true;
        if (activeReader?.cancel) {
            await activeReader.cancel(reason);
        } else if (body?.cancel) {
            await body.cancel(reason);
        }
    };
    const releaseReader = () => {
        if (readerReleased) return;
        readerReleased = true;
        activeReader?.releaseLock?.();
    };
    const onAbort = () => { void cancelReader(createAnalysisAbortError()); };
    if (signal) {
        abortListener = onAbort;
        signal.addEventListener('abort', abortListener, { once: true });
        if (signal.aborted) onAbort();
    }
    const cleanupAbortListener = () => {
        if (signal && abortListener) {
            signal.removeEventListener('abort', abortListener);
            abortListener = null;
        }
    };
    return {
        cancel: cancelReader,
        // scannerがreaderを取得できない場合も、取得層からbodyを回収できる。
        cleanup: async (reason) => {
            cleanupAbortListener();
            try { await cancelReader(reason); } catch (error) { }
            try { releaseReader(); } catch (error) { }
        },
        getReader() {
            const reader = body.getReader();
            activeReader = reader;
            if (signal?.aborted) void cancelReader(createAnalysisAbortError());
            let timer = null;
            const clear = () => {
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
            };
            return {
                async read() {
                    clear();
                    if (signal?.aborted) {
                        await cancelReader(createAnalysisAbortError());
                        throw createAnalysisAbortError();
                    }
                    timer = setTimeout(() => {
                        onStall();
                        void cancelReader();
                    }, PNG_STREAM_STALL_TIMEOUT_MS);
                    try {
                        return await reader.read();
                    } finally {
                        clear();
                    }
                },
                cancel(reason) {
                    clear();
                    return cancelReader(reason);
                },
                releaseLock() {
                    clear();
                    releaseReader();
                },
            };
        },
    };
}

/**
 * 既に読み進めた prefix chunk を先に再生し、その後は同じ reader から続きを読む
 * stream 互換オブジェクトを作る。
 * PNG判定のために消費した先頭bytesをscannerへ渡し直すために使う。
 * @param {Uint8Array[]} bufferedChunks - すでに読み終えたchunk
 * @param {Object} reader - body から取得済みの reader
 * @returns {Object} - stream 互換オブジェクト
 */
function createReplayStream(bufferedChunks, reader) {
    let readerCancelled = false;
    let readerReleased = false;
    const cancelReader = async (reason) => {
        if (readerCancelled) return;
        readerCancelled = true;
        await reader.cancel(reason);
    };
    const releaseReader = () => {
        if (readerReleased) return;
        readerReleased = true;
        reader.releaseLock();
    };
    return {
        cancel: cancelReader,
        cleanup: async (reason) => {
            try { await cancelReader(reason); } catch (error) { }
            try { releaseReader(); } catch (error) { }
        },
        getReader() {
            let index = 0;
            return {
                async read() {
                    if (index < bufferedChunks.length) {
                        return { done: false, value: bufferedChunks[index++] };
                    }
                    return reader.read();
                },
                cancel: cancelReader,
                releaseLock: releaseReader,
            };
        },
    };
}

/**
 * 全body stream の PNG 解析を集約ゲート配下で実行する。
 * ゲート枠を取得してから stream を開くため、枠待ちの間に転送を始めない。
 * @param {Object} params
 * @param {number} params.charge - in-flight byte として計上する量
 * @param {Object|null} params.context - 解析context (優先度・tab・signal)
 * @param {Function} params.openStream - async (signal) => stream|null
 * @returns {Promise<Object|null>} - scanner結果。streamを開けない場合はnull
 */
async function runGatedPngStreamScan({ charge, context, openStream }) {
    const release = await pngFullStreamGate.acquire({
        charge,
        priority: () => context?.priority ?? ANALYSIS_PRIORITY_BATCH,
        tabId: context?.tabId ?? null,
        order: context?.order ?? ANALYSIS_ORDER_FIFO,
        signal: context?.signal ?? null,
    });

    // fetch と body read を一つの AbortController へ束ねる。
    // 上位の取り消しと停滞タイムアウトの双方をここで受ける。
    let controller = new AbortController();
    const abortFromParent = () => controller.abort();
    context?.signal?.addEventListener('abort', abortFromParent, { once: true });
    let stalled = false;
    const onStall = () => {
        stalled = true;
        controller.abort();
    };
    let stream = null;
    let openTimer = setTimeout(onStall, PNG_STREAM_STALL_TIMEOUT_MS);

    try {
        stream = await openStream(controller.signal);
        clearTimeout(openTimer);
        openTimer = null;
        if (!stream) return null;
        return await scanPngMetadataStream(
            withStallTimeout(stream, onStall, controller.signal),
            { signal: controller.signal }
        );
    } catch (error) {
        if (stalled) {
            const stallError = new Error(
                `PNG stream stalled for more than ${PNG_STREAM_STALL_TIMEOUT_MS}ms.`
            );
            stallError.name = 'TimeoutError';
            throw stallError;
        }
        throw error;
    } finally {
        if (openTimer !== null) clearTimeout(openTimer);
        // scannerがreaderを取得する前の例外やgate中断でもbodyを残さない。
        if (stream?.cleanup) {
            try { await stream.cleanup(controller.signal.reason); } catch (cleanupError) { }
        }
        context?.signal?.removeEventListener('abort', abortFromParent);
        controller = null;
        release();
    }
}

async function runGatedPngBufferScan({ buffer, charge, context }) {
    const release = await pngFullStreamGate.acquire({
        charge,
        priority: () => context?.priority ?? ANALYSIS_PRIORITY_BATCH,
        tabId: context?.tabId ?? null,
        order: context?.order ?? ANALYSIS_ORDER_FIFO,
        signal: context?.signal ?? null,
    });
    try {
        return scanPngMetadataBuffer(buffer, { signal: context?.signal ?? null });
    } finally {
        release();
    }
}

// metadata head 取得のゲート。軽いので比較的広く取る。
const metadataHeadGate = new ConcurrencyGate({
    name: 'metadata-head',
    maxConcurrent: MAX_CONCURRENT_METADATA_HEAD_FETCHES,
});

// 全body stream のゲート。本数と in-flight byte 予算の両方を適用する。
const pngFullStreamGate = new ConcurrencyGate({
    name: 'png-full-stream',
    maxConcurrent: MAX_CONCURRENT_PNG_FULL_STREAMS,
    budgetBytes: PNG_FULL_STREAM_INFLIGHT_BUDGET_BYTES,
});

/**
 * URL単位で解析を共有する。
 * 同一URLを複数tab・複数frameが要求しても解析は1本に集約し、
 * すべての要求元が取り消したときだけ中断する。
 * handleFetchImageMetadata() の引数契約を変えずに、AbortSignal と
 * ゲート用contextを内部から参照するための仕組みでもある。
 */
const inFlightAnalyses = new Map();

/**
 * 現在進行中の解析contextを取得する
 * @param {string} imageUrl
 * @returns {Object|null}
 */
function getAnalysisContext(imageUrl) {
    return inFlightAnalyses.get(imageUrl) || null;
}

/**
 * 解析を開始または既存の解析へ合流する
 * @param {string} imageUrl - 対象URL
 * @param {Object} [options]
 * @param {number|null} [options.tabId] - 要求元tab
 * @param {number} [options.priority] - 優先度
 * @param {string} [options.order] - 取り出し順
 * @returns {Promise<Object>} - handleFetchImageMetadata の結果
 */
function requestImageMetadata(imageUrl, { tabId = null, priority = ANALYSIS_PRIORITY_BATCH,
    order = ANALYSIS_ORDER_FIFO } = {}) {
    const existing = inFlightAnalyses.get(imageUrl);
    if (existing && !existing.settled && existing.signal && !existing.signal.aborted) {
        existing.activeRefs += 1;
        // 後から届いた高優先度要求へ引き上げる
        if (priority > existing.priority) existing.priority = priority;
        if (tabId !== null) existing.tabIds.add(tabId);
        return existing.promise;
    }

    const controller = new AbortController();
    const entry = {
        controller,
        signal: controller.signal,
        activeRefs: 1,
        settled: false,
        priority,
        order,
        tabId,
        tabIds: new Set(tabId === null ? [] : [tabId]),
        promise: null,
    };
    inFlightAnalyses.set(imageUrl, entry);
    entry.promise = (async () => {
        let release = null;
        try {
            release = await metadataHeadGate.acquire({
                priority: () => entry.priority,
                tabId: entry.tabId,
                order: entry.order,
                signal: entry.signal,
            });
            return await handleFetchImageMetadata(imageUrl);
        } catch (error) {
            debugLog('[AI Meta Viewer] Analysis rejected before completion:', {
                url: imageUrl,
                name: error.name,
                message: error.message,
            });
            return { success: false, error: error.message, aborted: error.name === 'AbortError' };
        } finally {
            if (release) release();
            entry.settled = true;
            entry.activeRefs = 0;
            if (inFlightAnalyses.get(imageUrl) === entry) {
                inFlightAnalyses.delete(imageUrl);
            }
            entry.controller = null;
            entry.signal = null;
        }
    })();
    return entry.promise;
}

/**
 * 解析の取り消しを要求する。
 * すべての要求元が取り消したときだけ実際に中断する。
 * @param {string} imageUrl - 対象URL
 * @returns {boolean} - 実際に中断した場合 true
 */
function cancelImageMetadata(imageUrl) {
    const entry = inFlightAnalyses.get(imageUrl);
    if (!entry || entry.settled || entry.activeRefs <= 0) return false;
    entry.activeRefs -= 1;
    if (entry.activeRefs > 0 || !entry.controller) return false;
    if (entry.controller.signal.aborted) return true;
    entry.controller.abort();
    return true;
}

/**
 * 要求した Range 上限を超える 206 応答を表す error 名。
 * Content-Range 自体は自己整合しており Range 実装の不備ではないため、
 * この失敗で domain 全体の Range を無効化してはならない。
 */
const RANGE_OVER_DELIVERY_ERROR_NAME = 'RangeOverDeliveryError';

/**
 * 要求範囲を超えて配送された 206 応答用の error を生成する
 * @param {number} observedEnd - 応答が示した end
 * @param {number} requestedEnd - 要求した end
 * @returns {Error}
 */
function createRangeOverDeliveryError(observedEnd, requestedEnd) {
    const error = new Error(
        `Content-Range end (${observedEnd}) exceeds requested range end (${requestedEnd}).`
    );
    error.name = RANGE_OVER_DELIVERY_ERROR_NAME;
    return error;
}

/**
 * 非PNG入力が容量上限を超えたことを表す error 名。
 * 同じ応答を取り直しても結果は変わらないため、full fetch へ fallback しない。
 */
const METADATA_SIZE_LIMIT_ERROR_NAME = 'MetadataSizeLimitError';
const METADATA_HEAD_BUDGET_ERROR_NAME = 'MetadataHeadBudgetError';
const METADATA_JPEG_HEAD_BUDGET_BYTES = 256 * 1024;
const METADATA_AVIF_HEAD_BUDGET_BYTES = 256 * 1024;
const METADATA_WEBP_HEAD_BUDGET_BYTES = 64 * 1024;
const MAX_WEBP_TAIL_DECLARED_SIZE = 256 * 1024 * 1024;
const METADATA_SAFETENSORS_HEAD_BUDGET_BYTES = 16 * 1024 * 1024;

/**
 * parserの内部状態をbackground側の互換入力から解決する。
 * @param {Object} metadata - parser結果
 * @returns {string} - resolved / empty-confirmed / unresolved / unsupported-format
 */
function getMetadataState(metadata) {
    if (!metadata || typeof metadata !== 'object') return 'unresolved';
    if (metadata.parserState) return metadata.parserState;
    if (metadata.isIncomplete || metadata.requiresTailFetch) return 'unresolved';
    return Object.keys(metadata).length > 0 ? 'resolved' : 'empty-confirmed';
}

function getMetadataHeadBudget(format) {
    switch (format) {
        case 'jpeg': return METADATA_JPEG_HEAD_BUDGET_BYTES;
        case 'avif': return METADATA_AVIF_HEAD_BUDGET_BYTES;
        case 'webp': return METADATA_WEBP_HEAD_BUDGET_BYTES;
        case 'safetensors': return METADATA_SAFETENSORS_HEAD_BUDGET_BYTES;
        default: return FULL_FETCH_SIZE_LIMIT;
    }
}

/**
 * WebP RIFFヘッダーに含まれる宣言サイズを安全に取得する。
 * Content-Lengthがない場合でもtail取得の上限判定にだけ利用する。
 * @param {Uint8Array|ArrayBuffer} value - 先頭bytes
 * @returns {number|null} - RIFF全体の宣言サイズ、または不明
 */
function getDeclaredWebpSize(value) {
    const view = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
    if (view.length < 12 ||
        view[0] !== 0x52 || view[1] !== 0x49 || view[2] !== 0x46 || view[3] !== 0x46 ||
        view[8] !== 0x57 || view[9] !== 0x45 || view[10] !== 0x42 || view[11] !== 0x50) {
        return null;
    }
    const riffPayloadSize = view[4] + (view[5] << 8) + (view[6] << 16) + (view[7] * 0x1000000);
    const totalSize = riffPayloadSize + 8;
    return Number.isSafeInteger(totalSize) && totalSize >= 12 &&
        totalSize <= MAX_WEBP_TAIL_DECLARED_SIZE ? totalSize : null;
}

function isBoundedMetadataFormat(format) {
    return ['jpeg', 'avif', 'webp', 'safetensors'].includes(format);
}

/**
 * 形式別head budgetを使い切っても完了条件に到達しなかった場合のerror。
 * @param {number} observed - 保持したbyte数
 * @param {number} limit - 形式別budget
 * @param {string} format - 形式
 * @returns {Error}
 */
function createMetadataHeadBudgetError(observed, limit, format) {
    const error = new Error(
        `${format} metadata head (${observed} bytes) reached budget (${limit} bytes) without a complete parse.`
    );
    error.name = METADATA_HEAD_BUDGET_ERROR_NAME;
    error.format = format;
    error.limit = limit;
    error.observed = observed;
    return error;
}

/**
 * 容量上限超過の error を生成する。
 * @param {number} observed - 観測したbyte数
 * @param {number} limit - 上限
 * @returns {Error}
 */
function createMetadataSizeLimitError(observed, limit) {
    const error = new Error(
        `File size (${observed} bytes) exceeds safety limit (${limit} bytes).`
    );
    error.name = METADATA_SIZE_LIMIT_ERROR_NAME;
    return error;
}

/**
 * Range Request 失敗を rangeRequestBlockList へ登録すべきかを判定する。
 * サーバーが Range を構造的に扱えないと判断できる場合だけ登録する。
 * timeout・abort・一過性のネットワークエラーで登録すると、その domain の
 * 以降の全画像が full fetch へ退行し、非PNGの容量上限に直撃するため除外する。
 * @param {Error} error - 発生した例外
 * @param {number|undefined} status - HTTP ステータス
 * @returns {boolean} - block list へ登録する場合 true
 */
function isStructuralRangeFailure(error, status) {
    // AbortError は timeout もしくは明示的な中断であり、Range 非対応の根拠にならない
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return false;
    // 過剰配送は当該リクエストだけの問題であり、以降の Range を諦める理由にならない
    if (error && error.name === RANGE_OVER_DELIVERY_ERROR_NAME) return false;
    // ステータスを得られていない場合はネットワーク層の失敗であり構造的判断ができない
    if (typeof status !== 'number') return false;
    // 206 を返しているのに解析できなかった場合は Range 実装の不備として扱う
    if (status === HTTP_PARTIAL_CONTENT_STATUS) return true;
    // 200 は Range 無視、416 は Range 非対応として扱う。
    // 429・5xxなどのリソース／一時障害はdomain全体のblock根拠にしない。
    return status === HTTP_OK_STATUS || status === 416;
}

// デフォルト設定
const DEFAULT_SETTINGS = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000,
    downloaderFolderMode: 'id_pageTitle', // 'id_pageTitle', 'pageTitle', 'domain', 'none'
    downloaderBaseFolder: 'AI_Meta_Viewer',
    downloaderUseRoot: false,
    version: '1.6.0',
    // 共有設定の追加
    modalWidth: 800,
    modalHeight: 600,
    modalX: 'center',
    modalY: 'center',
    enableMetadataEditing: false,
    advancedModeEnabled: false,
    enableExperimentalWriting: false,
    // スキャン機能設定
    disableScanner: false // ページスキャン機能の無効化
};

// 現在の設定（起動時に読み込み）
settings = { ...DEFAULT_SETTINGS };

/**
 * Range Request の失敗情報を標準化してログに出力する
 * @param {Object} details - リクエストの詳細
 */
function logRangeRequestFailure(details) {
    debugLog('[AI Meta Viewer] Range Request failure details:', {
        phase: details.phase,
        domain: details.domain || '(unknown)',
        url: details.url,
        status: details.status ?? null,
        errorName: details.error?.name || 'Error',
        errorMessage: details.error?.message || String(details.error || 'Unknown error')
    });
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
        // 優先度と取り出し順はメッセージ本体ではなく action で表現し、
        // fetchImageMetadata の契約を { action, imageUrl } のまま維持する。
        requestImageMetadata(request.imageUrl, {
            tabId: sender?.tab?.id ?? null,
            priority: ANALYSIS_PRIORITY_BATCH,
            order: ANALYSIS_ORDER_FIFO,
        })
            .then(sendResponse)
            .catch(error => {
                debugLog('Metadata fetch error', error);
                sendResponse({ success: false, error: error.message });
            });

        // 非同期レスポンスを返すため true を返す
        return true;
    }

    // viewport 由来の解析。待機列は LIFO とし、スクロール中は最新の可視領域を優先する。
    if (request.action === 'fetchImageMetadataForViewport') {
        requestImageMetadata(request.imageUrl, {
            tabId: sender?.tab?.id ?? null,
            priority: ANALYSIS_PRIORITY_VIEWPORT,
            order: ANALYSIS_ORDER_LIFO,
        })
            .then(sendResponse)
            .catch(error => {
                debugLog('Metadata fetch error', error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }

    // hover 由来の解析。待機列の先頭へ昇格させ、待たせない。
    if (request.action === 'fetchImageMetadataForHover') {
        requestImageMetadata(request.imageUrl, {
            tabId: sender?.tab?.id ?? null,
            priority: ANALYSIS_PRIORITY_HOVER,
            order: ANALYSIS_ORDER_LIFO,
        })
            .then(sendResponse)
            .catch(error => {
                debugLog('Metadata fetch error', error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }

    // 画面外へ出た画像などの解析取り消し
    if (request.action === 'cancelImageMetadata') {
        const cancelled = cancelImageMetadata(request.imageUrl);
        sendResponse({ success: true, cancelled });
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
                debugLog('Clear all data error', error);
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
                debugLog('Get data statistics error', error);
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
                debugLog('Size fetch error', error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }

    if (request.action === 'writeMetadataAndDownload') {
        handleWriteMetadataAndDownload(request.imageUrl, request.metadata)
            .then(sendResponse)
            .catch(error => {
                debugLog('Write metadata error', error);
                sendResponse({ success: false, error: error.message });
            });
        return true;
    }
});

/**
 * メタデータを書き換えてダウンロードを実行
 * (隠し機能)
 */
async function handleWriteMetadataAndDownload(imageUrl, metadataObj) {
    debugLog('[AI Meta Viewer] Starting metadata rewrite/download for:', imageUrl);
    try {
        const response = await fetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

        const buffer = await response.arrayBuffer();

        // メタデータの統合 (Positive, Negative, Other を A1111 形式に再構成)
        let finalMetadataText = '';
        if (typeof metadataObj === 'string') {
            finalMetadataText = metadataObj;
        } else {
            const { positive, negative, other } = metadataObj;
            finalMetadataText = (positive || '').trim();
            if (negative && negative.trim()) {
                finalMetadataText += `\nNegative prompt: ${(negative || '').trim()}`;
            }
            if (other && other.trim()) {
                finalMetadataText += `\n${(other || '').trim()}`;
            }
        }

        const modifiedBytes = await rewriteImageMetadata(buffer, finalMetadataText);
        const format = detectImageFormat(buffer);
        // NOTE: rewriteImageMetadata throws for AVIF, so 'image/avif' branch is unreachable.
        // Kept for completeness in case AVIF write support is added in the future.
        const mimeType = format === 'png' ? 'image/png' : format === 'webp' ? 'image/webp' : format === 'avif' ? 'image/avif' : 'image/jpeg';
        const blob = new Blob([modifiedBytes], { type: mimeType });

        // Service Worker 環境での Data URL 化
        const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });

        // 元のファイル名を維持
        const urlObj = new URL(imageUrl);
        const pathSegments = urlObj.pathname.split('/');
        let filename = pathSegments.pop() || 'image';

        // デコードとクエリパラメータ除去
        try {
            filename = decodeURIComponent(filename.split('?')[0]);
        } catch (e) {
            filename = filename.split('?')[0];
        }

        // 元のベース名と拡張子を分離
        const dotIndex = filename.lastIndexOf('.');
        let baseName = dotIndex !== -1 ? filename.substring(0, dotIndex) : filename;
        // 拡張子を小文字に正規化
        const extension = (dotIndex !== -1 ? filename.substring(dotIndex) : `.${format || 'png'}`).toLowerCase();

        // ファイル名として不適切な文字を置換 (Windows/OSの制限)
        baseName = baseName.replace(/[\\/:*?"<>|]/g, '_');

        // ファイル名長制限
        const MAX_BASENAME_LENGTH = 80;
        if (baseName.length > MAX_BASENAME_LENGTH) {
            baseName = baseName.substring(0, MAX_BASENAME_LENGTH);
        }

        // フォルダ名をプレフィックスとして付与し、ブラウザに「意図的な保存」であることを伝える
        // これにより Data URL 使用時でも指定名が優先されやすくなる
        const finalPath = `AI_Meta_Viewer/${baseName}_edited${extension}`;
        debugLog('[AI Meta Viewer] Final download path:', finalPath);
        debugLog('[AI Meta Viewer] Data URL length:', dataUrl.length);

        await chrome.downloads.download({
            url: dataUrl,
            filename: finalPath,
            saveAs: true
        });

        return { success: true };
    } catch (e) {
        throw e;
    }
}

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
chrome.action.onClicked.addListener(async (tab) => {
    debugLog('[AI Meta Viewer] Extension icon clicked on tab:', tab.id);

    // スキャン機能が無効化されている場合は何もしない
    // (Service Worker 再起動直後でも確実に判定できるよう、ストレージから直接読み込む)
    try {
        const { disableScanner } = await chrome.storage.sync.get({ disableScanner: false });
        if (disableScanner) {
            debugLog('[AI Meta Viewer] Scanner is disabled by settings, ignoring icon click');
            return;
        }
    } catch (e) {
        debugLog('[AI Meta Viewer] Failed to check scanner setting:', e);
        return;
    }

    chrome.tabs.sendMessage(tab.id, { action: 'scanPage' }).catch(err => {
        debugLog('[AI Meta Viewer] Failed to send scanPage message', err);
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
                    debugLog('[AI Meta Viewer] Download API error', { category: 'download', phase: 'download', errorType: 'unknown' });
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
            debugLog('[AI Meta Viewer] Download request error', { category: 'download', phase: 'download', errorType: 'unknown' });
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
                    debugLog('[AI Meta Viewer] ZIP image fetch error', { category: 'download', phase: 'download', errorType: 'unknown' });
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
            debugLog('[AI Meta Viewer] ZIP compression error', e);
            throw e;
        }
    }

    return downloadedCount;
}


/**
 * 画像を取得してメタデータを抽出
 * Adaptive Range Request Logic 実装
 */
async function handleFetchImageMetadata(imageUrl) {
    if (typeof initializationState !== 'undefined' &&
        typeof INITIALIZATION_STATES !== 'undefined' &&
        initializationState === INITIALIZATION_STATES.FATAL) {
        return createInitializationUnavailableResult();
    }

    debugLog('[AI Meta Viewer] Fetching metadata for:', imageUrl);

    // blob: URL は Service Worker からアクセス不可のためスキップ
    if (imageUrl.startsWith('blob:')) {
        debugLog('[AI Meta Viewer] Skipping blob: URL (not accessible from Service Worker):', imageUrl);
        return { success: true, metadata: {} };
    }

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

        if (cachedMetadata.cacheEntryState === 'empty-confirmed' ||
            cachedMetadata.cacheEntryState === 'unsupported-format') {
            return { success: true, metadata: {}, cached: true };
        }

        // 空のメタデータは旧scanner版の結果を含み得るため再解析する。
        // Safetensorsの既存判定・ログ挙動は維持する。
        if (Object.keys(cachedMetadata).length === 0) {
            if (isSafetensorsUrl) {
                debugLog('[AI Meta Viewer] Cached metadata is empty for Safetensors. Bypassing cache to retry with new logic...', imageUrl);
            } else {
                debugLog('[AI Meta Viewer] Empty cached metadata treated as a cache miss:', imageUrl);
            }
        } else {
            debugLog('[AI Meta Viewer] Persistent Cache hit:', imageUrl, 'Keys:', Object.keys(cachedMetadata).join(', '));
            return { success: true, metadata: cachedMetadata, cached: true };
        }
    }

    // 取得開始前にschemeを一度だけ解決し、file:をHTTP取得経路から分離する。
    let parsedImageUrl = null;
    let imageScheme = '';
    try {
        parsedImageUrl = new URL(imageUrl);
        imageScheme = parsedImageUrl.protocol;
    } catch (urlError) {
        // 後続の既存取得経路で従来どおり失敗分類するため、schemeは空のままにする。
    }

    // parser.js チェック
    if (typeof extractMetadata !== 'function') {
        debugLog('[AI Meta Viewer] Error: extractMetadata function not found');
        return { success: false, error: 'Parser not loaded' };
    }

    const isFileScheme = imageScheme === 'file:';
    let filePhase = isFileScheme ? 'acquisition' : null;
    let fileResponseStatus;
    let fileBodyPresent;
    const sanitizeFileDiagnosticMessage = (error) => {
        const rawMessage = typeof error === 'string'
            ? error
            : error?.message || String(error || 'Unknown error');
        return rawMessage
            .replace(/(?:file:\/\/|[A-Za-z]:[\\/])[^\s'"`)]*/gi, '[redacted-path]')
            .replace(/(?:^|\s)\/[^\s'"`)]*/g, '$1[redacted-path]')
            .replace(/(?:\b[0-9a-f]{2}\s+){3,}[0-9a-f]{2}\b/gi, '[redacted-bytes]')
            .slice(0, 240);
    };
    const classifyFileError = (error) => {
        if (error?.name === 'AbortError') {
            return error?.isTimeout || /stalled|timeout/i.test(error.message || '')
                ? 'timeout'
                : 'abort';
        }
        if (error?.name === 'TimeoutError' || /stalled|timeout/i.test(error?.message || '')) {
            return 'timeout';
        }
        if (filePhase === 'acquisition' &&
            ['NotAllowedError', 'SecurityError', 'NetworkError'].includes(error?.name)) {
            return 'file-access';
        }
        return 'acquisition';
    };
    const createFileFailureResult = (error) => {
        const category = classifyFileError(error);
        const safeMessages = {
            'file-access': 'File access was denied.',
            acquisition: 'File metadata acquisition failed.',
            timeout: 'File metadata acquisition timed out.',
            abort: 'File metadata acquisition was aborted.',
        };
        const diagnostics = {
            category,
            scheme: 'file',
            phase: filePhase || 'acquisition',
            status: typeof fileResponseStatus === 'number' ? fileResponseStatus : undefined,
            bodyPresent: fileBodyPresent === true,
            errorName: error?.name || 'Error',
            message: safeMessages[category] || sanitizeFileDiagnosticMessage(error),
        };
        return {
            success: false,
            error: diagnostics.message || category,
            diagnostics,
        };
    };

    const sanitizeScannerDiagnostics = (value, depth = 0) => {
        const forbiddenKeys = new Set([
            'metadata', 'payload', 'bytes', 'signature', 'observedPrefix', 'value',
        ]);
        if (depth > 4 || value === null || value === undefined) return value;
        if (typeof value === 'string') return sanitizeFileDiagnosticMessage(value);
        if (typeof value !== 'object') return value;
        if (Array.isArray(value)) {
            return value.slice(0, 32).map((entry) => sanitizeScannerDiagnostics(entry, depth + 1));
        }
        const result = {};
        for (const [key, entry] of Object.entries(value).slice(0, 32)) {
            if (forbiddenKeys.has(key)) continue;
            result[key] = sanitizeScannerDiagnostics(entry, depth + 1);
        }
        return result;
    };

    try {
        let buffer;
        let isRangeRequest = false;
        let rangeRepresentationComplete = false;
        let domain = parsedImageUrl?.hostname || '';
        let totalFileSize = 0; // 追加：Rangeリクエスト時の総サイズ保持
        // Content-Range の complete-length が `*` の場合、総サイズは不明となる。
        // tail fetch は総サイズが既知であることを前提とするため明示的に区別する。
        let totalFileSizeKnown = false;
        // PNG を全body保持せず stream で受け取った場合の入力。
        // これが設定されている間は buffer を持たない。
        let pngStreamInput = null;
        let pngBufferRequiresGate = false;
        let pngBufferCharge = PNG_FULL_STREAM_UNKNOWN_SIZE_CHARGE_BYTES;

        // 解析単位のAbortSignalを全取得・再試行経路へ伝播する。
        const analysisSignal = getAnalysisContext(imageUrl)?.signal || null;
        let activeUrl = imageUrl;

        /**
         * byte-0再取得でPNG以外のrepresentationが返った場合のerrorを生成する。
         * drift自体は検出せず、再取得結果をPNG入力として検証した結果だけを返す。
         * @param {Uint8Array} prefix - 再取得bodyの先頭bytes
         * @returns {Error} - representation mismatch error
         */
        const createRepresentationMismatchError = (prefix) => {
            const bytes = prefix instanceof Uint8Array ? prefix : new Uint8Array(prefix);
            const error = new Error(
                'PNG representation mismatch: byte-0 response does not start with the PNG signature.'
            );
            error.name = 'RepresentationMismatchError';
            error.category = 'representation-mismatch';
            error.diagnostics = [{
                category: 'representation-mismatch',
                expected: 'png-signature',
                observedPrefix: Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join(' '),
            }];
            return error;
        };

        /**
         * 応答をmetadata解析用のbounded inputへ変換する。
         * PNGはsignature後にstreamへ渡し、非PNGは形式別完了条件またはhead budgetで止める。
         * @param {Response} response - 応答
         * @param {Object} [options] - PNG stream許可設定
         * @returns {Promise<Object>} - bufferまたはPNG streamの解析入力
         */
        const readResponseForMetadata = async (response, {
            allowPngStream = true,
            allowBodylessFileFallback = false,
            signal = null,
        } = {}) => {
            const declaredLength = Number(response.headers?.get?.('content-length'));
            const charge = Number.isSafeInteger(declaredLength) && declaredLength > 0
                ? declaredLength
                : PNG_FULL_STREAM_UNKNOWN_SIZE_CHARGE_BYTES;
            const formatPrefixLimit = 12;

            if (!response.body || typeof response.body.getReader !== 'function') {
                const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
                const bodylessPng = contentType.includes('image/png');
                const bodylessLimit = allowBodylessFileFallback
                    ? FILE_BODYLESS_FALLBACK_LIMIT
                    : bodylessPng ? BODYLESS_PNG_FALLBACK_LIMIT : FULL_FETCH_SIZE_LIMIT;
                const hasDeclaredLength = Number.isSafeInteger(declaredLength) && declaredLength >= 0;
                if (!hasDeclaredLength || declaredLength > bodylessLimit) {
                    throw createMetadataSizeLimitError(
                        hasDeclaredLength ? declaredLength : bodylessLimit + 1,
                        bodylessLimit,
                    );
                }
                const fullBuffer = await response.arrayBuffer();
                if (fullBuffer.byteLength > bodylessLimit ||
                    (hasDeclaredLength && fullBuffer.byteLength > declaredLength)) {
                    throw createMetadataSizeLimitError(fullBuffer.byteLength, bodylessLimit);
                }
                const pngPrefix = classifyPngPrefix(fullBuffer);
                if (pngPrefix === PNG_PREFIX_PNG) {
                    if (!allowPngStream) {
                        throw createRepresentationMismatchError(
                            new Uint8Array(fullBuffer).subarray(0, PNG_SIGNATURE.length)
                        );
                    }
                    return {
                        kind: 'png-buffer',
                        buffer: fullBuffer,
                        charge,
                        gateRequired: true,
                    };
                }
                const format = detectImageFormat(fullBuffer);
                const budget = getMetadataHeadBudget(format);
                if (isBoundedMetadataFormat(format) && fullBuffer.byteLength > budget) {
                    const limited = fullBuffer.slice(0, budget);
                    const boundedMetadata = extractMetadata(limited, {
                        format,
                        inputComplete: false,
                    });
                    const state = getMetadataState(boundedMetadata);
                    if (state === 'resolved' || state === 'empty-confirmed') {
                        return { kind: 'buffer', buffer: limited };
                    }
                    if (format === 'webp' && boundedMetadata.requiresTailFetch) {
                        return {
                            kind: 'buffer',
                            buffer: limited,
                            inputComplete: false,
                            requiresTailFetch: true,
                            totalFileSize: fullBuffer.byteLength,
                            totalFileSizeKnown: true,
                        };
                    }
                    throw createMetadataHeadBudgetError(fullBuffer.byteLength, budget, format);
                }
                if (!format && fullBuffer.byteLength > FULL_FETCH_SIZE_LIMIT) {
                    throw createMetadataSizeLimitError(fullBuffer.byteLength, FULL_FETCH_SIZE_LIMIT);
                }
                return { kind: 'buffer', buffer: fullBuffer };
            }

            const reader = response.body.getReader();
            const chunks = [];
            const prefix = new Uint8Array(formatPrefixLimit);
            let prefixLength = 0;
            let totalLength = 0;
            let pngPrefix = PNG_PREFIX_UNDETERMINED;
            let format = null;
            let handedOverToScanner = false;
            let boundedMetadata = null;
            let declaredFormatSize = null;
            let nextParseAt = 0;

            const materialize = () => {
                const buffer = new Uint8Array(totalLength);
                let offset = 0;
                for (const chunk of chunks) {
                    buffer.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                return buffer.buffer;
            };
            let readerCancelled = false;
            let readerReleased = false;
            let abortListener = null;
            const cancelReader = async () => {
                if (readerCancelled) return;
                readerCancelled = true;
                try { await reader.cancel(); } catch (e) { debugLog('[AI Meta Viewer] metadata reader cancel failed:', e.message); }
            };
            const releaseReader = () => {
                if (readerReleased) return;
                readerReleased = true;
                try { reader.releaseLock(); } catch (e) { debugLog('[AI Meta Viewer] metadata reader release failed:', e.message); }
            };
            if (signal) {
                abortListener = () => { void cancelReader(createAnalysisAbortError()); };
                signal.addEventListener('abort', abortListener, { once: true });
            }
            const readWithStallTimeout = async () => {
                let timer = null;
                const timeoutPromise = new Promise((resolve, reject) => {
                    timer = setTimeout(() => {
                        void cancelReader();
                        const timeoutError = new Error('Metadata response stream stalled.');
                        timeoutError.name = 'TimeoutError';
                        reject(timeoutError);
                    }, PNG_STREAM_STALL_TIMEOUT_MS);
                });
                try {
                    return await Promise.race([reader.read(), timeoutPromise]);
                } finally {
                    if (timer !== null) clearTimeout(timer);
                }
            };

            try {
                while (true) {
                    const record = await readWithStallTimeout();
                    if (record.done) break;
                    if (signal?.aborted) throw createAnalysisAbortError();
                    const chunk = record.value instanceof Uint8Array
                        ? record.value
                        : new Uint8Array(record.value);

                    if (prefixLength < prefix.length) {
                        const amount = Math.min(prefix.length - prefixLength, chunk.byteLength);
                        prefix.set(chunk.subarray(0, amount), prefixLength);
                        prefixLength += amount;
                    }
                    if (pngPrefix === PNG_PREFIX_UNDETERMINED) {
                        pngPrefix = classifyPngPrefix(prefix.subarray(0, prefixLength));
                    }
                    if (pngPrefix === PNG_PREFIX_PNG) {
                        if (!allowPngStream) {
                            await cancelReader();
                            throw createRepresentationMismatchError(prefix.subarray(0, prefixLength));
                        }
                        chunks.push(chunk);
                        totalLength += chunk.byteLength;
                        handedOverToScanner = true;
                        return {
                            kind: 'png-stream',
                            stream: createReplayStream(chunks, reader),
                            charge,
                        };
                    }

                    if (!format && prefixLength >= 3) {
                        format = detectImageFormatDetailed(prefix.subarray(0, prefixLength)).format;
                    }
                    if (format === 'webp' && declaredFormatSize === null) {
                        declaredFormatSize = getDeclaredWebpSize(prefix.subarray(0, prefixLength));
                    }
                    const budget = getMetadataHeadBudget(format);
                    const remaining = budget - totalLength;
                    if (remaining <= 0) {
                        await cancelReader();
                        throw createMetadataHeadBudgetError(totalLength, budget, format || 'unknown');
                    }
                    const accepted = chunk.byteLength > remaining
                        // budgetを跨ぐchunkは必要prefixだけを独立保持し、
                        // 元chunkの超過領域をbacking store経由で保持しない。
                        ? chunk.slice(0, remaining)
                        : chunk;
                    chunks.push(accepted);
                    totalLength += accepted.byteLength;

                    if (format) {
                        if (nextParseAt === 0) {
                            nextParseAt = Math.min(budget, Math.max(formatPrefixLimit, 4096));
                        }
                        // chunkごとのmaterializeを避け、解析点を指数的に増やす。
                        // これにより大きな非PNG streamでも累積O(n²)にならない。
                        const shouldParse = totalLength >= nextParseAt || totalLength >= budget;
                        if (shouldParse) {
                            const partialBuffer = materialize();
                            const partialMetadata = extractMetadata(partialBuffer, {
                                format,
                                inputComplete: false,
                            });
                            boundedMetadata = partialMetadata;
                            const state = getMetadataState(partialMetadata);
                            if (state === 'resolved' || state === 'empty-confirmed') {
                                await cancelReader();
                                return { kind: 'buffer', buffer: partialBuffer };
                            }
                            nextParseAt = Math.min(
                                budget,
                                Math.max(nextParseAt * 2, nextParseAt + 4096),
                            );
                        }
                    }

                    if (chunk.byteLength > accepted.byteLength || totalLength >= budget) {
                        await cancelReader();
                        if (format === 'webp' &&
                            boundedMetadata?.requiresTailFetch &&
                            (Number.isSafeInteger(declaredLength) && declaredLength > totalLength ||
                                Number.isSafeInteger(declaredFormatSize) && declaredFormatSize > totalLength)) {
                            const completeSize = Number.isSafeInteger(declaredLength) && declaredLength > totalLength
                                ? declaredLength
                                : declaredFormatSize;
                            return {
                                kind: 'buffer',
                                buffer: materialize(),
                                inputComplete: false,
                                requiresTailFetch: true,
                                totalFileSize: completeSize,
                                totalFileSizeKnown: true,
                            };
                        }
                        throw createMetadataHeadBudgetError(totalLength, budget, format || 'unknown');
                    }
                }
            } finally {
                if (signal && abortListener) {
                    signal.removeEventListener('abort', abortListener);
                }
                if (!handedOverToScanner) {
                    await cancelReader();
                    releaseReader();
                }
            }

            if (pngPrefix === PNG_PREFIX_UNDETERMINED) pngPrefix = PNG_PREFIX_NOT_PNG;
            const buffer = materialize();
            if (!format && prefixLength >= 3) {
                format = detectImageFormat(buffer);
            }
            if (pngPrefix === PNG_PREFIX_PNG) {
                if (!allowPngStream) {
                    throw createRepresentationMismatchError(
                        new Uint8Array(buffer).subarray(0, PNG_SIGNATURE.length)
                    );
                }
                return { kind: 'png-buffer', buffer };
            }
            if (format) {
                const finalMetadata = extractMetadata(buffer, {
                    format,
                    inputComplete: true,
                });
                if (getMetadataState(finalMetadata) === 'unresolved' &&
                    isBoundedMetadataFormat(format) && totalLength >= getMetadataHeadBudget(format)) {
                    throw createMetadataHeadBudgetError(totalLength, getMetadataHeadBudget(format), format);
                }
            } else if (totalLength > FULL_FETCH_SIZE_LIMIT) {
                throw createMetadataSizeLimitError(totalLength, FULL_FETCH_SIZE_LIMIT);
            }
            return { kind: 'buffer', buffer };
        };


        /**
         * 初期取得用の全取得 Fetch。PNGはstreamで受け取れる。
         * @param {string} url - 取得URL
         * @returns {Promise<Object>} - readResponseForMetadata の結果
         */
        const safeFetchFullInput = async (url, signal = null) => {
            const response = await fetch(url, { redirect: 'follow', signal });
            if (response.status !== HTTP_OK_STATUS) throw new Error(`HTTP ${response.status}`);
            return readResponseForMetadata(response, { allowPngStream: true, signal });
        };

        /**
         * 非PNG経路の再試行用の全取得 Fetch。buffer だけを返す。
         * この経路は既に非PNGと判定された画像にだけ使われるため、
         * PNG が返った場合は representation drift として失敗させる。
         * @param {string} url - 取得URL
         * @returns {Promise<ArrayBuffer>}
         */
        const safeFetchFull = async (url, signal = null) => {
            const response = await fetch(url, { redirect: 'follow', signal });
            if (response.status !== HTTP_OK_STATUS) throw new Error(`HTTP ${response.status}`);
            const input = await readResponseForMetadata(response, { allowPngStream: false, signal });
            if (input.kind === 'png-buffer') {
                throw createRepresentationMismatchError(
                    new Uint8Array(input.buffer).subarray(0, PNG_SIGNATURE.length)
                );
            }
            return input.buffer;
        };

        if (isFileScheme) {
            let fileController = new AbortController();
            const analysisContext = getAnalysisContext(imageUrl);
            const parentSignal = analysisContext?.signal;
            const abortFromParent = () => fileController?.abort();
            let parentListenerAttached = false;
            try {
                if (parentSignal) {
                    if (parentSignal.aborted) throw createAnalysisAbortError();
                    parentSignal.addEventListener('abort', abortFromParent, { once: true });
                    parentListenerAttached = true;
                }
                const response = await fetch(imageUrl, {
                    redirect: 'follow',
                    signal: fileController.signal,
                });
                fileResponseStatus = response?.status;
                fileBodyPresent = Boolean(response?.body);
                if (!response || response.status !== HTTP_OK_STATUS) {
                    const statusError = new Error(
                        `File fetch failed with HTTP ${response?.status ?? 'unknown'}.`
                    );
                    statusError.name = 'ResponseStatusError';
                    throw statusError;
                }
                const input = await readResponseForMetadata(response, {
                    allowPngStream: true,
                    allowBodylessFileFallback: true,
                    signal: fileController.signal,
                });
                if (input.kind === 'png-stream') {
                    pngStreamInput = input;
                    rangeRepresentationComplete = true;
                } else {
                    buffer = input.buffer;
                    pngBufferRequiresGate = input.gateRequired === true;
                    pngBufferCharge = input.charge || PNG_FULL_STREAM_UNKNOWN_SIZE_CHARGE_BYTES;
                    totalFileSizeKnown = input.totalFileSizeKnown !== false;
                    totalFileSize = totalFileSizeKnown
                        ? (input.totalFileSize || buffer.byteLength)
                        : buffer.byteLength;
                    rangeRepresentationComplete = input.inputComplete !== false;
                }
            } catch (error) {
                if (pngStreamInput?.stream?.cleanup) {
                    try { await pngStreamInput.stream.cleanup(error); } catch (cleanupError) { }
                    pngStreamInput = null;
                }
                return createFileFailureResult(error);
            } finally {
                if (parentSignal && parentListenerAttached) {
                    parentSignal.removeEventListener('abort', abortFromParent);
                }
                fileController = null;
            }
        } else {
            // URLフェッチ: Range Request 試行
            const shouldUseRange = !rangeRequestBlockList.has(domain);

            if (shouldUseRange) {
                const rangeSize = 65535;
                let response;
                try {
                    // URL タイプの判定
                    const isCivitaiApiUrl = imageUrl.includes('civitai.com/api/download/models/');
                    const isCloudflareCDN = imageUrl.includes('cloudflarestorage.com');

                    if (isCivitaiApiUrl || isCloudflareCDN) {
                        debugLog('[AI Meta Viewer] Resolving final URL for Range request:', imageUrl.substring(0, 80));
                        try {
                            const headResp = await fetch(imageUrl, {
                                method: 'HEAD',
                                redirect: 'follow',
                                signal: analysisSignal,
                            });
                            if (headResp.ok) {
                                activeUrl = headResp.url;
                                debugLog('[AI Meta Viewer] ✓ Final URL resolved:', activeUrl.substring(0, 80));
                            }
                        } catch (headErr) {
                            debugLog('[AI Meta Viewer] ⚠ URL resolution failed, using original:', headErr.message);
                        }
                    }

                    const rangeHeader = `bytes=0-${rangeSize}`;
                    debugLog('[AI Meta Viewer] Range Request attempt:', {
                        domain: domain || '(unknown)',
                        url: activeUrl,
                        range: rangeHeader
                    });

                    const controller = new AbortController();
                    const abortFromAnalysis = () => controller.abort();
                    if (analysisSignal) {
                        if (analysisSignal.aborted) controller.abort();
                        else analysisSignal.addEventListener('abort', abortFromAnalysis, { once: true });
                    }
                    const timeoutId = setTimeout(
                        () => controller.abort(),
                        RANGE_REQUEST_TIMEOUT_MS
                    );

                    try {
                        response = await fetch(activeUrl, {
                            headers: { 'Range': rangeHeader },
                            signal: controller.signal
                        });

                        debugLog('[AI Meta Viewer] Range Request response:', {
                            domain: domain || '(unknown)',
                            url: activeUrl,
                            status: response.status,
                            ok: response.ok,
                            range: rangeHeader
                        });

                        if (response.status === HTTP_PARTIAL_CONTENT_STATUS) {
                            const contentRange = parseContentRangeHeader(response.headers.get('Content-Range'));
                            if (!contentRange || contentRange.start !== 0) {
                                throw new Error('Invalid Content-Range for initial PNG representation.');
                            }
                            // 要求範囲より広い応答を受理すると、上限を迂回した保持量になる。
                            // Content-Range は body より先に届くため、body を materialize
                            // する前に判定してキャンセルできる。
                            if (contentRange.end > rangeSize) {
                                if (response.body && typeof response.body.cancel === 'function') {
                                    // 過剰配送された payload を読み込まずに破棄する
                                    Promise.resolve(response.body.cancel()).catch(() => { });
                                }
                                throw createRangeOverDeliveryError(contentRange.end, rangeSize);
                            }
                            isRangeRequest = true;
                            buffer = await response.arrayBuffer();
                            if (buffer.byteLength !== contentRange.length) {
                                throw new Error('Content-Range length does not match response body length.');
                            }
                            // total が `*` のときは表現全体か判定できないため partial として扱う
                            totalFileSizeKnown = contentRange.total !== null;
                            totalFileSize = totalFileSizeKnown ? contentRange.total : 0;
                            rangeRepresentationComplete = totalFileSizeKnown &&
                                contentRange.length === contentRange.total;
                            debugLog(`[AI Meta Viewer] Content-Range validated: ${contentRange.start}-${contentRange.end}/${contentRange.total ?? '*'}`);
                        } else if (response.status === HTTP_OK_STATUS) {
                            // サーバーがRangeを無視した場合。PNGだけは2MB上限を適用せず、
                            // 全body を保持せず stream で scanner へ渡す。
                            const input = await readResponseForMetadata(response, {
                                signal: analysisSignal,
                            });
                            if (input.kind === 'png-stream') {
                                pngStreamInput = input;
                            } else {
                                buffer = input.buffer;
                                pngBufferRequiresGate = input.gateRequired === true;
                                pngBufferCharge = input.charge || PNG_FULL_STREAM_UNKNOWN_SIZE_CHARGE_BYTES;
                                totalFileSizeKnown = input.totalFileSizeKnown !== false;
                                totalFileSize = totalFileSizeKnown
                                    ? (input.totalFileSize || buffer.byteLength)
                                    : buffer.byteLength;
                                // WebPのhead＋tail入力だけは、既存tail Rangeへ接続する。
                                isRangeRequest = input.requiresTailFetch === true && totalFileSizeKnown;
                                rangeRepresentationComplete = input.inputComplete !== false;
                            }
                            if (input.kind === 'png-stream') {
                                rangeRepresentationComplete = true;
                            }
                        } else {
                            throw new Error(`Range request failed with status ${response.status}`);
                        }
                    } finally {
                        clearTimeout(timeoutId);
                        if (analysisSignal) {
                            analysisSignal.removeEventListener('abort', abortFromAnalysis);
                        }
                    }

                } catch (e) {
                    // 容量上限超過は同じ応答を取り直しても結果が変わらない。
                    // full fetch へ fallback せず、二重ダウンロードを避ける。
                    if (e.name === METADATA_SIZE_LIMIT_ERROR_NAME ||
                        e.name === METADATA_HEAD_BUDGET_ERROR_NAME) throw e;

                    const rangeFailure = {
                        phase: 'initial',
                        domain,
                        url: activeUrl,
                        status: response?.status,
                        error: e
                    };
                    logRangeRequestFailure(rangeFailure);

                    const isCivitaiDomain = CivitaiDomainManager.shouldExemptFromBlocking(domain);
                    const isHuggingFaceDomain = HuggingFaceDomainManager.shouldExemptFromBlocking(domain);
                    if (isCivitaiDomain || isHuggingFaceDomain) {
                        debugLog('[AI Meta Viewer] Range Request block exemption:', {
                            domain,
                            reason: isCivitaiDomain
                                ? 'civitai.com domains are exempt from rangeRequestBlockList'
                                : 'huggingface.co domains are exempt from rangeRequestBlockList',
                            status: response?.status ?? null,
                            error: e.message
                        });
                    } else if (domain && !isStructuralRangeFailure(e, response?.status)) {
                        // timeout・abort・一過性ネットワークエラーでは domain を無効化しない。
                        // 1枚の失敗で domain 全体が full fetch へ退行すると容量上限に直撃する。
                        debugLog('[AI Meta Viewer] Range Request failure treated as transient, keeping domain enabled:', {
                            domain,
                            reason: e.message,
                            errorName: e.name ?? null,
                            status: response?.status ?? null
                        });
                    } else if (domain) {
                        debugLog('[AI Meta Viewer] Adding domain to rangeRequestBlockList:', {
                            domain,
                            reason: e.message,
                            status: response?.status ?? null
                        });
                        rangeRequestBlockList.add(domain);
                    } else {
                        debugLog('[AI Meta Viewer] Range Request failed without a blockable domain:', {
                            status: response?.status ?? null,
                            error: e.message
                        });
                    }

                    debugLog('[AI Meta Viewer] Falling back to safe full fetch after Range Request failure:', {
                        domain: domain || '(unknown)',
                        url: imageUrl
                    });
                    const fallbackInput = await safeFetchFullInput(activeUrl, getAnalysisContext(imageUrl)?.signal);
                    isRangeRequest = false;
                    rangeRepresentationComplete = true;
                    if (fallbackInput.kind === 'png-stream') {
                        pngStreamInput = fallbackInput;
                    } else {
                        buffer = fallbackInput.buffer;
                        pngBufferRequiresGate = fallbackInput.gateRequired === true;
                        pngBufferCharge = fallbackInput.charge || PNG_FULL_STREAM_UNKNOWN_SIZE_CHARGE_BYTES;
                        totalFileSizeKnown = fallbackInput.totalFileSizeKnown !== false;
                        totalFileSize = totalFileSizeKnown
                            ? (fallbackInput.totalFileSize || buffer.byteLength)
                            : buffer.byteLength;
                        isRangeRequest = fallbackInput.requiresTailFetch === true && totalFileSizeKnown;
                        rangeRepresentationComplete = fallbackInput.inputComplete !== false;
                    }
                    if (fallbackInput.kind === 'png-stream') {
                        rangeRepresentationComplete = true;
                    }
                }
            } else {
                debugLog('[AI Meta Viewer] Range Request skipped for blocked domain:', {
                    domain: domain || '(unknown)',
                    reason: 'domain is already in rangeRequestBlockList'
                });
                const blockedInput = await safeFetchFullInput(imageUrl, getAnalysisContext(imageUrl)?.signal);
                rangeRepresentationComplete = true;
                if (blockedInput.kind === 'png-stream') {
                    pngStreamInput = blockedInput;
                } else {
                    buffer = blockedInput.buffer;
                    pngBufferRequiresGate = blockedInput.gateRequired === true;
                    pngBufferCharge = blockedInput.charge || PNG_FULL_STREAM_UNKNOWN_SIZE_CHARGE_BYTES;
                    totalFileSizeKnown = blockedInput.totalFileSizeKnown !== false;
                    totalFileSize = totalFileSizeKnown
                        ? (blockedInput.totalFileSize || buffer.byteLength)
                        : buffer.byteLength;
                    isRangeRequest = blockedInput.requiresTailFetch === true && totalFileSizeKnown;
                    rangeRepresentationComplete = blockedInput.inputComplete !== false;
                }
                if (blockedInput.kind === 'png-stream') {
                    rangeRepresentationComplete = true;
                }
            }
        }

        const detectedFormat = pngStreamInput ? 'png' : detectImageFormat(buffer);
        if (detectedFormat === 'png') {
            if (isFileScheme) filePhase = 'scanner';
            const analysisContext = getAnalysisContext(imageUrl);

            /**
             * byte 0 から取り直した全body stream を解析する。
             * ゲート枠を取得してから fetch するため、枠待ちの間に転送を始めない。
             * @param {string} url - 取得URL
             * @returns {Promise<Object>} - scanner結果
             */
            const scanPngFromByteZero = async (url) => {
                // 集約予算。total が不明な場合は仮計上する。
                const charge = totalFileSizeKnown && totalFileSize > 0
                    ? totalFileSize
                    : PNG_FULL_STREAM_UNKNOWN_SIZE_CHARGE_BYTES;
                let bufferedFallback = null;
                const streamed = await runGatedPngStreamScan({
                    charge,
                    context: analysisContext,
                    openStream: async (signal) => {
                        const response = await fetch(url, { redirect: 'follow', signal });
                        if (!response.ok) throw new Error(`PNG fetch failed with HTTP ${response.status}`);

                        if (response.body && typeof response.body.getReader === 'function') {
                            const reader = response.body.getReader();
                            const prefixChunks = [];
                            const prefix = new Uint8Array(PNG_SIGNATURE.length);
                            let prefixLength = 0;
                            try {
                                while (prefixLength < PNG_SIGNATURE.length) {
                                    const record = await reader.read();
                                    if (record.done) break;
                                    const chunk = record.value instanceof Uint8Array
                                        ? record.value
                                        : new Uint8Array(record.value);
                                    prefixChunks.push(chunk);
                                    const amount = Math.min(
                                        PNG_SIGNATURE.length - prefixLength,
                                        chunk.byteLength,
                                    );
                                    prefix.set(chunk.subarray(0, amount), prefixLength);
                                    prefixLength += amount;
                                    if (classifyPngPrefix(prefix.subarray(0, prefixLength)) === PNG_PREFIX_NOT_PNG) {
                                        throw createRepresentationMismatchError(prefix.subarray(0, prefixLength));
                                    }
                                }
                                if (classifyPngPrefix(prefix.subarray(0, prefixLength)) !== PNG_PREFIX_PNG) {
                                    throw createRepresentationMismatchError(prefix.subarray(0, prefixLength));
                                }
                                return createReplayStream(prefixChunks, reader);
                            } catch (error) {
                                try { await reader.cancel(); } catch (cancelError) {
                                    debugLog('[AI Meta Viewer] byte-0 mismatch reader cancel failed:', cancelError.message);
                                }
                                try { reader.releaseLock(); } catch (releaseError) {
                                    debugLog('[AI Meta Viewer] byte-0 mismatch reader release failed:', releaseError.message);
                                }
                                throw error;
                            }
                        }

                        bufferedFallback = await response.arrayBuffer();
                        const prefix = new Uint8Array(bufferedFallback).subarray(0, PNG_SIGNATURE.length);
                        if (classifyPngPrefix(prefix) !== PNG_PREFIX_PNG) {
                            throw createRepresentationMismatchError(prefix);
                        }
                        return null;
                    },
                });
                if (streamed) return streamed;
                return runGatedPngBufferScan({
                    buffer: bufferedFallback,
                    charge,
                    context: analysisContext,
                });
            };

            const completeRepresentation = !isRangeRequest || rangeRepresentationComplete;
            let scanResult;
            if (pngStreamInput) {
                // Rangeを無視されたHTTP 200など、全body を保持せず stream で受け取った入力。
                // 追加取得せず、そのまま同一scannerへ渡す。
                const streamInput = pngStreamInput;
                pngStreamInput = null;
                try {
                    scanResult = await runGatedPngStreamScan({
                        charge: streamInput.charge,
                        context: analysisContext,
                        openStream: async () => streamInput.stream,
                    });
                } finally {
                    try { await streamInput?.stream?.cleanup?.(); } catch (cleanupError) { }
                }
            } else if (pngBufferRequiresGate) {
                // Response.bodyが無い実装では全body bufferを取得済みでも、
                // PNGの展開・検証は全body gateの集約予算内で実行する。
                scanResult = await runGatedPngBufferScan({
                    buffer,
                    charge: pngBufferCharge,
                    context: analysisContext,
                });
            } else if (completeRepresentation) {
                // 初期206は要求Range上限で有界化されているため、保持済みbytesをbufferで渡す。
                scanResult = scanPngMetadataBuffer(buffer);
            } else {
                // partial headは後続断片へ接続せず、byte 0からのstreamだけを解析する。
                buffer = null;
                scanResult = await scanPngFromByteZero(activeUrl);
            }

            if (scanResult.status === 'normal' || scanResult.status === 'stealth') {
                const cacheResult = await metadataCache.set(
                    imageUrl,
                    scanResult.metadata,
                    { scannerVersion: PNG_SCANNER_CACHE_VERSION },
                );
                if (cacheResult && cacheResult.reason === 'size-limit') {
                    scanResult.diagnostics = [
                        ...(scanResult.diagnostics || []),
                        {
                            category: 'cache-skip',
                            detail: 'Valid PNG metadata exceeded the persistent cache item limit.',
                            limit: cacheResult.limit,
                            observed: cacheResult.observed,
                        },
                    ];
                }
                return {
                    success: true,
                    metadata: scanResult.metadata,
                    ...(isFileScheme ? { scannerStatus: scanResult.status } : {}),
                    diagnostics: scanResult.diagnostics
                };
            }
            if (scanResult.status === 'not-found') {
                // 有効IENDまで確認済みのnot-foundだけを、版数付きnegative cacheへ保存する。
                // invalid/resource-limit/取得失敗はこの分岐へ到達しないため保存しない。
                await metadataCache.set(imageUrl, {}, {
                    scannerVersion: PNG_SCANNER_CACHE_VERSION,
                    parserState: 'empty-confirmed',
                });
                return {
                    success: true,
                    metadata: {},
                    ...(isFileScheme ? { scannerStatus: scanResult.status } : {}),
                    diagnostics: scanResult.diagnostics
                };
            }

            const reason = scanResult.reason || scanResult.limit || scanResult.status;
            if (isFileScheme) {
                const category = scanResult.status === 'invalid-png'
                    ? 'invalid-png'
                    : scanResult.status === 'resource-limit'
                        ? 'resource-limit'
                        : 'scanner-failure';
                const scannerDiagnostics = sanitizeScannerDiagnostics(scanResult.diagnostics);
                const diagnostics = {
                    category,
                    scheme: 'file',
                    phase: 'scanner',
                    status: typeof fileResponseStatus === 'number' ? fileResponseStatus : undefined,
                    bodyPresent: fileBodyPresent === true,
                    errorName: 'PngScannerError',
                    message: `PNG scanner failed (${category}).`,
                    scannerStatus: scanResult.status,
                    ...(scanResult.reason ? { scannerReason: scanResult.reason } : {}),
                    ...(scannerDiagnostics ? { scannerDiagnostics } : {}),
                };
                return {
                    success: false,
                    error: diagnostics.message,
                    scannerStatus: scanResult.status,
                    ...(scanResult.reason ? { scannerReason: scanResult.reason } : {}),
                    diagnostics,
                };
            }
            return {
                success: false,
                error: `PNG scan failed: ${reason}`,
                diagnostics: scanResult.diagnostics,
            };
        }

        let metadata = {};
        try {
            metadata = extractMetadata(buffer, {
                format: detectedFormat,
                inputComplete: rangeRepresentationComplete,
            });

            // メタデータ不足時の再試行ロジック
            if (getMetadataState(metadata) === 'unresolved' && !isFileScheme) {

                if (!isRangeRequest) {
                    // file:// URL 等で Range が暗黙的に効いてバッファが切り詰められたケース
                    // safeFetchFull で全ファイルを取得して再解析
                    debugLog('[AI Meta Viewer] ⚠ Metadata incomplete but not a Range request. Attempting full fetch fallback.');
                    try {
                        const fullBuffer = await safeFetchFull(activeUrl, getAnalysisContext(imageUrl)?.signal);
                        buffer = fullBuffer;
                        totalFileSize = buffer.byteLength; // totalFileSize を更新
                        totalFileSizeKnown = true;
                        metadata = extractMetadata(buffer, {
                            format: detectedFormat,
                            inputComplete: true,
                        });

                        // full fetch 成功後、完全なメタデータが取得できた場合は以降の再試行をスキップ
                        if (getMetadataState(metadata) !== 'unresolved') {
                            debugLog('[AI Meta Viewer] ✅ Full fetch successful, metadata complete.');
                            // isRangeRequest は false のまま（Stealth PNG チェックでの重複ダウンロードを防ぐ）
                        } else {
                            // まだ incomplete の場合のみ、tail fetch を有効化
                            isRangeRequest = true;
                        }
                    } catch (fullFetchError) {
                        debugLog('[AI Meta Viewer] ⚠ Full fetch fallback failed:', fullFetchError.message);
                    }
                }

                // full fetch 後も metadata.isIncomplete を再チェック
                // 完全なメタデータが取得できた場合は以降の再試行をスキップ
                if (getMetadataState(metadata) === 'unresolved') {
                    // ComfyUI (PNGの末尾にメタデータがあるパターン)
                    // W2: totalFileSize が異常に小さい場合（W1の問題発生時）は tail fetch をスキップ
                    // tail 開始位置は総サイズから逆算するため、総サイズが既知であることを必須条件とする
                    if (metadata.requiresTailFetch && totalFileSizeKnown && totalFileSize > 65535 && isRangeRequest) {
                        const tailSize = 131072; // 末尾 128KB 取得
                        let tailStart = totalFileSize - tailSize;
                        if (tailStart < 65536) tailStart = 65536; // 既取得分と被らないように

                        debugLog(`[AI Meta Viewer] ⚠ ComfyUI signature detected. Fetching tail for metadata: bytes=${tailStart}-`);
                        try {
                            const controller = new AbortController();
                            const abortFromAnalysis = () => controller.abort();
                            if (analysisSignal) {
                                if (analysisSignal.aborted) controller.abort();
                                else analysisSignal.addEventListener('abort', abortFromAnalysis, { once: true });
                            }
                            const timeoutId = setTimeout(
                                () => controller.abort(),
                                RANGE_REQUEST_TIMEOUT_MS
                            );
                            let tailResponse;
                            try {
                                tailResponse = await fetch(activeUrl, {
                                    headers: { 'Range': `bytes=${tailStart}-` },
                                    signal: controller.signal
                                });

                                if (tailResponse.status === 206 || tailResponse.status === 200) {
                                    const tailBuffer = await tailResponse.arrayBuffer();

                                    // WebPの既存tail経路だけを維持する。
                                    const format = detectImageFormat(buffer);
                                    let tailMetadata = {};

                                    if (format === 'webp') {
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
                                    const tailFailure = new Error(`HTTP ${tailResponse.status}`);
                                    logRangeRequestFailure({
                                        phase: 'tail',
                                        domain,
                                        url: activeUrl,
                                        status: tailResponse.status,
                                        error: tailFailure
                                    });
                                    debugLog(`[AI Meta Viewer] ⚠ Tail Range failed (Status: ${tailResponse.status}), giving up.`);
                                }
                            } finally {
                                clearTimeout(timeoutId);
                                if (analysisSignal) {
                                    analysisSignal.removeEventListener('abort', abortFromAnalysis);
                                }
                            }
                            isRangeRequest = false; // これ以上のフェッチを防ぐ
                        } catch (tailError) {
                            logRangeRequestFailure({
                                phase: 'tail',
                                domain,
                                url: activeUrl,
                                error: tailError
                            });
                            debugLog('[AI Meta Viewer] ⚠ Tail Range threw error:', tailError.message);
                            isRangeRequest = false;
                        }
                    }
                    // 通常の再試行 (Safetensorsなど、前方をもっと読む)
                    else {
                        const retrySize = metadata.suggestedSize || 131072;
                        debugLog(`[AI Meta Viewer] ⚠ Metadata is incomplete. Retrying with larger range: 0-${retrySize}`);

                        let retryResponse;
                        try {
                            const retryRangeHeader = `bytes=0-${retrySize}`;
                            debugLog('[AI Meta Viewer] Range Request retry attempt:', {
                                domain: domain || '(unknown)',
                                url: activeUrl,
                                range: retryRangeHeader
                            });

                            const controller = new AbortController();
                            const abortFromAnalysis = () => controller.abort();
                            if (analysisSignal) {
                                if (analysisSignal.aborted) controller.abort();
                                else analysisSignal.addEventListener('abort', abortFromAnalysis, { once: true });
                            }
                            const timeoutId = setTimeout(
                                () => controller.abort(),
                                RANGE_REQUEST_TIMEOUT_MS
                            );
                            try {
                                retryResponse = await fetch(activeUrl, {
                                    headers: { 'Range': retryRangeHeader },
                                    signal: controller.signal
                                });

                                debugLog('[AI Meta Viewer] Range Request retry response:', {
                                    domain: domain || '(unknown)',
                                    url: activeUrl,
                                    status: retryResponse.status,
                                    ok: retryResponse.ok,
                                    range: retryRangeHeader
                                });

                                if (retryResponse.status === 206) {
                                    const newBuffer = await retryResponse.arrayBuffer();
                                    const retryRange = parseContentRangeHeader(
                                        retryResponse.headers?.get?.('Content-Range')
                                    );
                                    const retryComplete = retryRange?.total !== null &&
                                        retryRange?.total !== undefined &&
                                        retryRange.length === retryRange.total;
                                    const nextMetadata = extractMetadata(newBuffer, {
                                        format: detectedFormat,
                                        inputComplete: retryComplete,
                                    });
                                    const retryState = getMetadataState(nextMetadata);
                                    const budgetReached = isBoundedMetadataFormat(detectedFormat) &&
                                        newBuffer.byteLength >= getMetadataHeadBudget(detectedFormat);
                                    if (retryState === 'unresolved' && !budgetReached) {
                                        debugLog('[AI Meta Viewer] ⚠ Still incomplete. Falling back to safe full fetch.');
                                        const fullBuffer = await safeFetchFull(activeUrl, getAnalysisContext(imageUrl)?.signal);
                                        buffer = fullBuffer;
                                        totalFileSize = buffer.byteLength; // totalFileSize を更新
                                        totalFileSizeKnown = true;
                                        metadata = extractMetadata(fullBuffer, {
                                            format: detectedFormat,
                                            inputComplete: true,
                                        });
                                    } else {
                                        buffer = newBuffer;
                                        metadata = nextMetadata;
                                    }
                                } else {
                                    const retryFailure = new Error(`HTTP ${retryResponse.status}`);
                                    logRangeRequestFailure({
                                        phase: 'retry',
                                        domain,
                                        url: activeUrl,
                                        status: retryResponse.status,
                                        error: retryFailure
                                    });
                                    debugLog('[AI Meta Viewer] ⚠ Retry Range failed, falling back to safe full fetch.', {
                                        domain: domain || '(unknown)',
                                        status: retryResponse.status
                                    });
                                    const fullBuffer = await safeFetchFull(activeUrl, getAnalysisContext(imageUrl)?.signal);
                                    buffer = fullBuffer;
                                    totalFileSize = buffer.byteLength; // totalFileSize を更新
                                    metadata = extractMetadata(fullBuffer, {
                                        format: detectedFormat,
                                        inputComplete: true,
                                    });
                                }
                            } finally {
                                clearTimeout(timeoutId);
                                if (analysisSignal) {
                                    analysisSignal.removeEventListener('abort', abortFromAnalysis);
                                }
                            }
                            isRangeRequest = false;
                        } catch (retryError) {
                            logRangeRequestFailure({
                                phase: 'retry',
                                domain,
                                url: activeUrl,
                                status: retryResponse?.status,
                                error: retryError
                            });
                            debugLog('[AI Meta Viewer] ⚠ Range retry failed, final attempt with safe full fetch:', retryError.message);
                            const fullBuffer = await safeFetchFull(activeUrl, getAnalysisContext(imageUrl)?.signal);
                            buffer = fullBuffer;
                            totalFileSize = buffer.byteLength; // totalFileSize を更新
                            metadata = extractMetadata(fullBuffer, {
                                format: detectedFormat,
                                inputComplete: true,
                            });
                            isRangeRequest = false;
                        }
                    }
                } // if (metadata.isIncomplete) の終わり
            }
        } catch (e) {
            debugLog('[AI Meta Viewer] Parse failed, trying safe full fetch fallback:', e.message);
            if (isRangeRequest) {
                const fullBuffer = await safeFetchFull(activeUrl, getAnalysisContext(imageUrl)?.signal);
                buffer = fullBuffer;
                metadata = extractMetadata(buffer, {
                    format: detectedFormat,
                    inputComplete: true,
                });
                isRangeRequest = false;
            } else {
                throw e;
            }
        }

        const metadataState = getMetadataState(metadata);
        if (metadataState === 'unresolved') {
            throw new Error('Metadata parsing did not produce a complete representation.');
        }
        if (metadataState === 'empty-confirmed' || metadataState === 'unsupported-format') {
            await metadataCache.set(imageUrl, {}, {
                parserVersion: PARSER_CACHE_VERSION,
                parserState: metadataState,
            });
        } else if (Object.keys(metadata).length > 0) {
            await metadataCache.set(imageUrl, metadata, {
                parserVersion: PARSER_CACHE_VERSION,
            });
        }
        return { success: true, metadata: metadata };

    } catch (error) {
        if (isFileScheme) return createFileFailureResult(error);
        debugLog('[AI Meta Viewer] handleFetchImageMetadata error:', error.message);
        const result = { success: false, error: error.message };
        if (Array.isArray(error.diagnostics)) result.diagnostics = error.diagnostics;
        return result;
    }
}

// Service Worker起動時にライブラリを読み込む
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

// Service Worker 停止時にキャッシュインデックスを即時保存
chrome.runtime.onSuspend.addListener(async () => {
    if (metadataCache.saveTimer) {
        clearTimeout(metadataCache.saveTimer);
        metadataCache.saveTimer = null;
    }
    // デバウンス待ちの保存を即時実行（ベストエフォート: onSuspend内の非同期完了は仕様上保証されない）
    try {
        await metadataCache.storage.set({
            [metadataCache.metaKey]: Array.from(metadataCache.index.entries())
        });
    } catch (e) {
        debugLog('[AI Meta Viewer] Failed to save cache index on suspend', e);
    }
});

// Service Worker の動作確認用
loadSettings().then(() => {
    debugLog('[AI Meta Viewer] Chrome APIs available:', {
        runtime: !!chrome.runtime,
        storage: !!chrome.storage,
        tabs: !!chrome.tabs,
        downloads: !!chrome.downloads,
        action: !!chrome.action
    });
    debugLog('[AI Meta Viewer] Background script initialization complete');
});

