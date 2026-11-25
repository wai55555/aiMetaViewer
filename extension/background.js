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
const SAFE_DEBUG_EVENTS = Object.freeze([
    'request-start', 'cache-lookup', 'parse-result', 'request-failure',
    'check-skipped', 'analysis-skip', 'analysis-start', 'stale-result', 'cache-hit', 'cache-miss', 'response',
    'analysis-complete', 'badge-show', 'cancel', 'queue-skip', 'queue-enqueue',
    'queue-cancel-pending', 'queue-finish', 'dom-remove', 'src-mutation', 'source-selection-change',
]);
const SAFE_CACHE_STATES = Object.freeze([
    'miss', 'hit-positive', 'hit-empty', 'hit-legacy-empty', 'legacy-empty-reparse',
]);
const SAFE_ANALYSIS_OUTCOMES = Object.freeze([
    'resolved', 'confirmed-empty', 'unresolved', 'resource-limit', 'failure', 'cancelled', 'source-changed',
]);
const SAFE_DEBUG_REASONS = Object.freeze([
    'processed-marker', 'viewport-exit', 'dom-removed', 'src-change', 'source-selection',
    'request-active', 'request-inactive', 'already-running', 'already-pending', 'queue-overflow',
    'context-invalid', 'no-src', 'site-excluded', 'too-small',
]);

let initializationState = INITIALIZATION_STATES.PENDING;
let fatalInitializationSignalEmitted = false;
let settings = { debugMode: false };
let settingsLoaded = false;
const pendingContentDiagnosticLogs = [];
const MAX_PENDING_CONTENT_DIAGNOSTIC_LOGS = 256;

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

function getSafeUrlId(url) {
    if (typeof url !== 'string' || url.length === 0) return undefined;
    let hashA = 2166136261;
    let hashB = 0x9e3779b9;
    for (let i = 0; i < url.length; i += 1) {
        const code = url.charCodeAt(i);
        hashA = Math.imul(hashA ^ code, 16777619);
        hashB = Math.imul(hashB ^ code, 2246822519);
    }
    return `${(hashA >>> 0).toString(16).padStart(8, '0')}${(hashB >>> 0).toString(16).padStart(8, '0')}`;
}

function applySafeDiagnosticObject(diagnostic, value) {
    if (value === null || typeof value !== 'object') return;

    try {
        if (value instanceof Error || typeof value.name === 'string') {
            diagnostic.errorType = inferSafeErrorType(value.name);
        }
        const safeKeys = [
            'category', 'phase', 'status', 'bodyPresent', 'scannerStatus', 'retryable',
            'event', 'cacheState', 'analysisOutcome', 'urlId', 'reason', 'imageId',
            'runId', 'imageIndex', 'candidateIndex', 'width', 'height',
            'processed', 'activeRequest', 'sameSrc', 'running', 'cancelled',
        ];
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
            if (key === 'event' && SAFE_DEBUG_EVENTS.includes(entry)) diagnostic.event = entry;
            if (key === 'cacheState' && SAFE_CACHE_STATES.includes(entry)) diagnostic.cacheState = entry;
            if (key === 'analysisOutcome' && SAFE_ANALYSIS_OUTCOMES.includes(entry)) diagnostic.analysisOutcome = entry;
            if (key === 'urlId' && typeof entry === 'string' && /^[a-f0-9]{16}$/.test(entry)) {
                diagnostic.urlId = entry;
            }
            if (key === 'reason' && SAFE_DEBUG_REASONS.includes(entry)) diagnostic.reason = entry;
            if (['imageId', 'runId', 'imageIndex', 'candidateIndex', 'width', 'height'].includes(key) &&
                Number.isSafeInteger(entry) && entry >= 0) {
                diagnostic[key] = entry;
            }
            if (['processed', 'activeRequest', 'sameSrc', 'running', 'cancelled'].includes(key) && typeof entry === 'boolean') {
                diagnostic[key] = entry;
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
        ['event', SAFE_DEBUG_EVENTS.includes(diagnostic?.event) ? diagnostic.event : undefined],
        ['urlId', typeof diagnostic?.urlId === 'string' && /^[a-f0-9]{16}$/.test(diagnostic.urlId) ? diagnostic.urlId : undefined],
        ['cacheState', SAFE_CACHE_STATES.includes(diagnostic?.cacheState) ? diagnostic.cacheState : undefined],
        ['analysisOutcome', SAFE_ANALYSIS_OUTCOMES.includes(diagnostic?.analysisOutcome) ? diagnostic.analysisOutcome : undefined],
        ['imageId', Number.isSafeInteger(diagnostic?.imageId) ? diagnostic.imageId : undefined],
        ['runId', Number.isSafeInteger(diagnostic?.runId) ? diagnostic.runId : undefined],
        ['imageIndex', Number.isSafeInteger(diagnostic?.imageIndex) ? diagnostic.imageIndex : undefined],
        ['candidateIndex', Number.isSafeInteger(diagnostic?.candidateIndex) ? diagnostic.candidateIndex : undefined],
        ['reason', SAFE_DEBUG_REASONS.includes(diagnostic?.reason) ? diagnostic.reason : undefined],
        ['activeRequest', typeof diagnostic?.activeRequest === 'boolean' ? diagnostic.activeRequest : undefined],
        ['processed', typeof diagnostic?.processed === 'boolean' ? diagnostic.processed : undefined],
        ['running', typeof diagnostic?.running === 'boolean' ? diagnostic.running : undefined],
        ['sameSrc', typeof diagnostic?.sameSrc === 'boolean' ? diagnostic.sameSrc : undefined],
        ['cancelled', typeof diagnostic?.cancelled === 'boolean' ? diagnostic.cancelled : undefined],
        ['width', Number.isSafeInteger(diagnostic?.width) ? diagnostic.width : undefined],
        ['height', Number.isSafeInteger(diagnostic?.height) ? diagnostic.height : undefined],
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
    importScripts('pako.js', 'jszip.min.js', 'parser.js', 'video_parser.js', 'video_range_reader.js', 'png_metadata_scanner.js');
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
const PNG_SCANNER_CACHE_VERSION = 'png-scanner-v2';
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
const FULL_FETCH_HEADERS_TIMEOUT_MS = 10000; // 全取得のレスポンスヘッダー待ち上限
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
    let readerCancellationPromise = null;
    let readerReleased = false;
    let abortListener = null;
    let terminationError = null;
    const rememberTermination = (reason) => {
        if (reason && !terminationError) terminationError = reason;
    };
    const cancelReader = async (reason) => {
        rememberTermination(reason);
        if (readerCancellationPromise) {
            await readerCancellationPromise;
            return;
        }
        readerCancelled = true;
        const cancel = activeReader?.cancel
            ? () => activeReader.cancel(reason)
            : body?.cancel
                ? () => body.cancel(reason)
                : null;
        if (!cancel) return;
        readerCancellationPromise = Promise.resolve()
            .then(cancel)
            .catch(() => { });
        await readerCancellationPromise;
    };
    const releaseReader = () => {
        if (readerReleased) return;
        readerReleased = true;
        activeReader?.releaseLock?.();
    };
    const onAbort = () => {
        const abortError = createAnalysisAbortError();
        rememberTermination(abortError);
        void cancelReader(abortError);
    };
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
                        const abortError = createAnalysisAbortError();
                        rememberTermination(abortError);
                        await cancelReader(abortError);
                        throw abortError;
                    }
                    timer = setTimeout(() => {
                        const timeoutError = new Error('PNG stream read stalled.');
                        timeoutError.name = 'TimeoutError';
                        rememberTermination(timeoutError);
                        void cancelReader(timeoutError);
                        onStall();
                    }, PNG_STREAM_STALL_TIMEOUT_MS);
                    try {
                        const record = await reader.read();
                        if (terminationError) throw terminationError;
                        if (signal?.aborted) throw createAnalysisAbortError();
                        return record;
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
    let readerCancellationPromise = null;
    let readerReleased = false;
    const cancelReader = async (reason) => {
        if (readerCancellationPromise) {
            await readerCancellationPromise;
            return;
        }
        readerCancelled = true;
        readerCancellationPromise = Promise.resolve()
            .then(() => reader.cancel(reason))
            .catch(() => { });
        await readerCancellationPromise;
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
        const result = await scanPngMetadataStream(
            withStallTimeout(stream, onStall, controller.signal),
            { signal: controller.signal }
        );
        if (stalled) {
            const stallError = new Error(
                `PNG stream stalled for more than ${PNG_STREAM_STALL_TIMEOUT_MS}ms.`
            );
            stallError.name = 'TimeoutError';
            throw stallError;
        }
        if (context?.signal?.aborted) throw createAnalysisAbortError();
        return result;
    } catch (error) {
        if (stalled) {
            const stallError = new Error(
                `PNG stream stalled for more than ${PNG_STREAM_STALL_TIMEOUT_MS}ms.`
            );
            stallError.name = 'TimeoutError';
            throw stallError;
        }
        if (context?.signal?.aborted) throw createAnalysisAbortError();
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
        const result = scanPngMetadataBuffer(buffer, { signal: context?.signal ?? null });
        if (context?.signal?.aborted) throw createAnalysisAbortError();
        return result;
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
const inFlightVideoAnalyses = new Map();

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

function requestVideoMetadata(videoUrl, { tabId = null } = {}) {
    const cacheUrl = `video-metadata-v1:${videoUrl}`;
    const existing = inFlightVideoAnalyses.get(cacheUrl);
    if (existing && !existing.settled && !existing.signal?.aborted) {
        existing.activeRefs += 1;
        return existing.promise;
    }

    const controller = new AbortController();
    const entry = {
        controller,
        signal: controller.signal,
        activeRefs: 1,
        settled: false,
        tabId,
        promise: null,
    };
    inFlightVideoAnalyses.set(cacheUrl, entry);
    entry.promise = (async () => {
        let release = null;
        try {
            release = await metadataHeadGate.acquire({
                priority: ANALYSIS_PRIORITY_VIEWPORT,
                tabId: entry.tabId,
                order: ANALYSIS_ORDER_LIFO,
                signal: entry.signal,
            });
            return await handleFetchVideoMetadata(videoUrl, entry.signal, cacheUrl);
        } catch (error) {
            return {
                success: false,
                analysisState: error?.name === 'AbortError' ? 'failure' : 'unresolved',
                diagnostics: {
                    category: error?.name === 'AbortError' ? 'cancelled' : 'acquisition',
                    phase: 'background',
                    errorType: error?.name === 'AbortError' ? 'abort' : 'unknown',
                    retryable: true,
                },
            };
        } finally {
            if (release) release();
            entry.settled = true;
            entry.activeRefs = 0;
            if (inFlightVideoAnalyses.get(cacheUrl) === entry) inFlightVideoAnalyses.delete(cacheUrl);
            entry.controller = null;
            entry.signal = null;
        }
    })();
    return entry.promise;
}

function cancelVideoMetadata(videoUrl) {
    const entry = inFlightVideoAnalyses.get(`video-metadata-v1:${videoUrl}`);
    if (!entry || entry.settled || entry.activeRefs <= 0) return false;
    entry.activeRefs -= 1;
    if (entry.activeRefs > 0 || !entry.controller) return false;
    if (entry.controller.signal.aborted) return true;
    entry.controller.abort();
    return true;
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
const MAX_WEBP_RIFF_SIZE_BYTES = 256 * 1024 * 1024;
const MAX_WEBP_STREAM_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_WEBP_DEEP_SCAN_BYTES = MAX_WEBP_RIFF_SIZE_BYTES;
const MAX_WEBP_BODYLESS_BUFFER_BYTES = 2 * 1024 * 1024;
const METADATA_SAFETENSORS_HEAD_BUDGET_BYTES = 16 * 1024 * 1024;

/**
 * Content-Length がない応答を長さ0として扱わない。
 * Headers#get は未設定時に null を返すため、Number(null) の0化を避ける。
 * @param {Headers|Object|null} headers - response headers
 * @returns {number|null} 有効な宣言長。欠落または不正なら null
 */
function getDeclaredContentLength(headers) {
    const headerValue = headers?.get?.('content-length');
    if (headerValue === null || headerValue === undefined || String(headerValue).trim() === '') {
        return null;
    }
    const normalizedHeaderValue = String(headerValue).trim();
    if (!/^\d+$/.test(normalizedHeaderValue)) {
        return null;
    }
    const contentLength = Number(normalizedHeaderValue);
    return Number.isSafeInteger(contentLength) && contentLength >= 0 ? contentLength : null;
}

/**
 * parserの内部状態をbackground側の互換入力から解決する。
 * @param {Object} metadata - parser結果
 * @returns {string} - resolved / empty-confirmed / resource-limit / unresolved / unsupported-format
 */
function getMetadataState(metadata) {
    if (!metadata || typeof metadata !== 'object') return 'unresolved';
    if (metadata.parserState) return metadata.parserState;
    if (metadata.isIncomplete || metadata.requiresTailFetch) return 'unresolved';
    return Object.keys(metadata).length > 0 ? 'resolved' : 'empty-confirmed';
}

function isMetadataScanComplete(metadata) {
    const state = getMetadataState(metadata);
    return state === 'empty-confirmed' ||
        state === 'resolved' && metadata?.metadataPartial !== true;
}

function hasMetadataPayload(metadata) {
    return Boolean(metadata && typeof metadata === 'object' &&
        Object.keys(metadata).some(key => key !== 'isIncomplete' && key !== 'requiresTailFetch'));
}

function mergeWebpStreamMetadata(metadata, result) {
    const merged = metadata && typeof metadata === 'object' ? metadata : {};
    if (!result || typeof result !== 'object') return merged;
    const alreadyPartial = merged.metadataPartial === true;
    const existingMetadataKeys = Object.keys(merged)
        .filter(key => key !== 'isIncomplete' && key !== 'requiresTailFetch');
    const streamMetadata = result.metadata && typeof result.metadata === 'object'
        ? result.metadata
        : {};
    for (const [key, value] of Object.entries(result.metadata || {})) merged[key] = value;
    delete merged.requiresTailFetch;
    const hasMetadata = Object.keys(merged).some(key => key !== 'isIncomplete' && key !== 'requiresTailFetch');
    const streamState = result.state;
    let state = 'unresolved';
    if (streamState === 'resolved' || hasMetadata) state = 'resolved';
    else if (streamState === 'resource-limit') state = 'resource-limit';
    else if (result.complete === true && streamState === 'empty-confirmed') state = 'empty-confirmed';
    else if (result.complete === true && streamState === 'invalid') state = 'invalid';
    if (state === 'unresolved') merged.isIncomplete = true;
    else delete merged.isIncomplete;
    Object.defineProperty(merged, 'parserState', {
        value: state,
        enumerable: false,
        configurable: true,
    });
    const fullStreamSupersedesExistingMetadata = result.complete === true &&
        streamState === 'resolved' &&
        existingMetadataKeys.every(key => Object.prototype.hasOwnProperty.call(streamMetadata, key));
    if (result.complete !== true || result.metadataPartial === true || result.incompleteMetadataChunk === true ||
        (alreadyPartial && !fullStreamSupersedesExistingMetadata)) {
        Object.defineProperty(merged, 'metadataPartial', {
            value: true,
            enumerable: false,
            configurable: true,
        });
    } else {
        delete merged.metadataPartial;
    }
    return merged;
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
 * Content-Lengthがない場合でもWebPストリーム上限判定に利用する。
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
        totalSize <= MAX_WEBP_RIFF_SIZE_BYTES ? totalSize : null;
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
    version: chrome.runtime.getManifest().version,
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
    settingsLoaded = true;
    debugLog('[AI Meta Viewer] Settings loaded:', settings);
    if (settings.debugMode === true) {
        for (const diagnostic of pendingContentDiagnosticLogs.splice(0)) {
            debugLog(diagnostic);
        }
    } else {
        pendingContentDiagnosticLogs.length = 0;
    }
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
    // Content Script の画像診断ログを Service Worker の DevTools に集約する。
    // background 側で再度 allowlist を通すため、任意文字列や URL は出力されない。
    if (request.action === 'contentDiagnostic') {
        if (sender?.id === chrome.runtime.id && request.diagnostic && typeof request.diagnostic === 'object') {
            const diagnostic = toSafeDiagnostic({
                ...request.diagnostic,
                category: 'scanner',
                phase: 'content',
            });
            if (settingsLoaded) {
                if (settings.debugMode === true) debugLog(diagnostic);
            } else if (pendingContentDiagnosticLogs.length < MAX_PENDING_CONTENT_DIAGNOSTIC_LOGS) {
                pendingContentDiagnosticLogs.push(diagnostic);
            }
        }
        sendResponse({ success: true });
        return true;
    }

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

    if (request.action === 'fetchVideoMetadata') {
        if (typeof request.videoUrl !== 'string' || request.videoUrl.length === 0) {
            sendResponse({ success: false, analysisState: 'failure', diagnostics: { category: 'message', phase: 'background', errorType: 'invalid-response' } });
            return false;
        }
        requestVideoMetadata(request.videoUrl, { tabId: sender?.tab?.id ?? null })
            .then(sendResponse)
            .catch(() => sendResponse({
                success: false,
                analysisState: 'unresolved',
                diagnostics: { category: 'acquisition', phase: 'background', errorType: 'unknown', retryable: true },
            }));
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
        debugLog({
            category: 'cancelled',
            phase: 'background',
            event: 'cancel',
            urlId: getSafeUrlId(request.imageUrl),
            cancelled,
        });
        sendResponse({ success: true, cancelled });
        return true;
    }

    if (request.action === 'cancelVideoMetadata') {
        const cancelled = cancelVideoMetadata(request.videoUrl);
        debugLog({
            category: 'cancelled',
            phase: 'background',
            event: 'cancel',
            urlId: getSafeUrlId(request.videoUrl),
            cancelled,
        });
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
 * Video metadata専用の取得。HTTP Rangeとfile://の両方で全body保持を避ける。
 * @param {string} videoUrl
 * @param {AbortSignal|null} signal
 * @param {string} cacheUrl
 */
async function handleFetchVideoMetadata(videoUrl, signal, cacheUrl) {
    if (typeof initializationState !== 'undefined' &&
        typeof INITIALIZATION_STATES !== 'undefined' &&
        initializationState === INITIALIZATION_STATES.FATAL) {
        return createInitializationUnavailableResult();
    }
    let parsedUrl;
    try { parsedUrl = new URL(videoUrl); } catch (_) {
        return { success: false, analysisState: 'failure', diagnostics: { category: 'acquisition', phase: 'background', errorType: 'invalid-response' } };
    }
    const urlId = getSafeUrlId(videoUrl);
    if (parsedUrl.protocol === 'blob:') {
        return { success: true, analysisState: 'confirmed-empty', metadata: {}, parserState: 'unsupported-format' };
    }
    if (!['http:', 'https:', 'file:'].includes(parsedUrl.protocol)) {
        return { success: false, analysisState: 'failure', diagnostics: { category: 'acquisition', phase: 'background', errorType: 'invalid-response', retryable: false } };
    }

    const cached = await metadataCache.get(cacheUrl);
    const cachedState = cached?.cacheEntryState;
    if (cachedState === 'empty-confirmed' || cachedState === 'unsupported-format') {
        return { success: true, analysisState: 'confirmed-empty', metadata: {}, cached: true, parserState: cachedState };
    }
    if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
        return { success: true, analysisState: 'resolved', metadata: cached, cached: true };
    }

    debugLog({ category: 'acquisition', phase: 'background', event: 'request-start', urlId });
    const isFile = parsedUrl.protocol === 'file:';
    let totalSize = null;
    let totalFetched = 0;
    let rangeIgnoredBody = null;
    let rangeIgnoredComplete = false;
    let rangeIgnoredOverLimit = false;
    let fetchBudgetBlocked = false;
    let responseStatus = null;
    let rangeValidator = null;
    let rangeIdentityUnavailable = false;
    let rangeRepresentationChanged = false;
    let rangeContentEncodingUnsupported = false;
    const fetchedRanges = [];
    const aborted = () => signal?.aborted === true;
    const cancelResponseBody = async response => {
        try { await response?.body?.cancel?.(); } catch (_) { }
    };

    const fetchBytes = async (offset, length) => {
        if (aborted()) throw createAnalysisAbortError();
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1) return null;
        if (length > VIDEO_METADATA_MAX_BYTES) {
            fetchBudgetBlocked = true;
            return null;
        }
        if (rangeIgnoredBody) {
            if (offset + length <= rangeIgnoredBody.length) return rangeIgnoredBody.subarray(offset, offset + length);
            if (rangeIgnoredOverLimit) fetchBudgetBlocked = true;
            return null;
        }
        for (const cachedRange of fetchedRanges) {
            if (offset >= cachedRange.start && offset + length <= cachedRange.end) {
                return cachedRange.bytes.subarray(offset - cachedRange.start, offset - cachedRange.start + length);
            }
        }
        if (!isFile && fetchedRanges.length > 0 && !rangeValidator) {
            rangeIdentityUnavailable = true;
            return null;
        }
        if (totalFetched + length > VIDEO_METADATA_MAX_BYTES) {
            fetchBudgetBlocked = true;
            return null;
        }

        const controller = new AbortController();
        const abortFromParent = () => controller.abort();
        if (signal) {
            if (signal.aborted) controller.abort();
            else signal.addEventListener('abort', abortFromParent, { once: true });
        }
        let timedOut = false;
        const timeoutId = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, RANGE_REQUEST_TIMEOUT_MS);
        try {
            const headers = isFile ? undefined : {
                Range: `bytes=${offset}-${offset + length - 1}`,
                ...(rangeValidator ? { 'If-Range': rangeValidator.value } : {}),
            };
            const response = await fetch(videoUrl, {
                headers,
                redirect: 'follow',
                signal: controller.signal,
            });
            responseStatus = response.status;
            if (response.status === HTTP_PARTIAL_CONTENT_STATUS && !isFile) {
                const contentEncoding = response.headers.get('content-encoding');
                if (typeof contentEncoding === 'string' && contentEncoding.trim() !== '') {
                    rangeContentEncodingUnsupported = true;
                    await cancelResponseBody(response);
                    return null;
                }
                const range = parseContentRangeHeader(response.headers.get('content-range'));
                if (!range || range.start !== offset || range.end > offset + length - 1 || range.length > length) {
                    await cancelResponseBody(response);
                    return null;
                }
                if (fetchedRanges.length > 0 && totalSize !== null && range.total !== null && range.total !== totalSize) {
                    rangeRepresentationChanged = true;
                    await cancelResponseBody(response);
                    return null;
                }
                if (rangeValidator) {
                    const observedValidator = response.headers.get('etag');
                    if (observedValidator && observedValidator !== rangeValidator.value) {
                        rangeRepresentationChanged = true;
                        await cancelResponseBody(response);
                        return null;
                    }
                } else if (fetchedRanges.length === 0) {
                    const etag = response.headers.get('etag');
                    if (typeof etag === 'string' && etag.trim() && !/^W\//i.test(etag.trim())) {
                        rangeValidator = { value: etag.trim() };
                    }
                }
                if (range.total !== null) totalSize = range.total;
                const body = await readVideoResponsePrefix(response, range.length, controller.signal);
                if (controller.signal.aborted) throw createAnalysisAbortError();
                totalFetched += body.observedBytes ?? body.bytes.length;
                if (!body.complete || body.overLimit || body.bytes.length !== range.length) return null;
                fetchedRanges.push({ start: offset, end: offset + body.bytes.length, bytes: body.bytes });
                return body.bytes;
            }
            if (response.status !== HTTP_OK_STATUS) {
                await cancelResponseBody(response);
                return null;
            }
            const contentLength = response.headers.get('content-length');
            const contentEncoding = response.headers.get('content-encoding');
            const hasContentEncoding = typeof contentEncoding === 'string' && contentEncoding.trim() !== '';
            if (!hasContentEncoding && typeof contentLength === 'string' && /^\d+$/.test(contentLength)) {
                const parsedLength = Number(contentLength);
                if (Number.isSafeInteger(parsedLength)) totalSize = parsedLength;
            }
            // A server can ignore a later Range request after earlier 206 responses.
            // Count that full-body fallback against the bytes already fetched.
            const remainingBytes = VIDEO_METADATA_MAX_BYTES - totalFetched;
            const body = await readVideoResponsePrefix(response, remainingBytes, controller.signal);
            if (controller.signal.aborted) throw createAnalysisAbortError();
            rangeIgnoredBody = body.bytes;
            rangeIgnoredComplete = body.complete;
            rangeIgnoredOverLimit = body.overLimit;
            totalFetched += body.observedBytes ?? body.bytes.length;
            fetchedRanges.length = 0;
            if (body.complete && hasContentEncoding) totalSize = body.bytes.length;
            else if (totalSize === null && body.complete) totalSize = body.bytes.length;
            if (offset + length <= body.bytes.length) return body.bytes.subarray(offset, offset + length);
            return null;
        } catch (error) {
            if (timedOut && !signal?.aborted) {
                const timeoutError = new Error('Video metadata request timed out.');
                timeoutError.name = 'TimeoutError';
                throw timeoutError;
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
            signal?.removeEventListener('abort', abortFromParent);
        }
    };

    const buildResult = async parserResult => {
        if (aborted()) throw createAnalysisAbortError();
        const state = parserResult?.parserState || 'unresolved';
        const isResourceLimit = state === 'resource-limit' || fetchBudgetBlocked || rangeIgnoredOverLimit;
        if (state === 'resolved' && Object.keys(parserResult).length > 0) {
            const metadata = {};
            for (const [key, value] of Object.entries(parserResult)) metadata[key] = value;
            await metadataCache.set(cacheUrl, metadata, { parserState: 'resolved' });
            return { success: true, analysisState: 'resolved', metadata, format: parserResult.format || 'video' };
        }
        if (state === 'empty-confirmed' || state === 'unsupported-format') {
            await metadataCache.set(cacheUrl, {}, { parserState: state });
            return { success: true, analysisState: 'confirmed-empty', metadata: {}, parserState: state, format: parserResult.format || 'video' };
        }
        return {
            success: false,
            analysisState: 'unresolved',
            parserState: state,
            reason: isResourceLimit
                ? (state === 'resource-limit' ? parserResult?.parserReason || parserResult?.reason || 'resource-limit' : 'resource-limit')
                : parserResult?.parserReason || parserResult?.reason || 'metadata-unresolved',
            diagnostics: {
                category: isResourceLimit ? 'resource-limit' : 'acquisition',
                phase: 'background',
                errorType: 'unknown',
                retryable: true,
                scheme: isFile ? 'file' : undefined,
                status: responseStatus || undefined,
                bodyPresent: totalFetched > 0,
            },
        };
    };

    try {
        if (typeof extractVideoMetadata !== 'function' || typeof scanWebmVideoMetadata !== 'function' ||
            typeof scanMp4VideoMetadata !== 'function') {
            return { success: false, analysisState: 'failure', diagnostics: { category: 'parser', phase: 'background', errorType: 'import' } };
        }

        const head = await fetchBytes(0, VIDEO_METADATA_HEAD_BYTES);
        const wholeResourceAvailable = rangeIgnoredComplete ||
            (!rangeIgnoredOverLimit && head && Number.isSafeInteger(totalSize) && head.length >= totalSize);
        if (!head || head.length < 4) {
            if (rangeIgnoredComplete && rangeIgnoredBody) {
                const fullFormat = detectVideoContainer(rangeIgnoredBody);
                return buildResult(extractVideoMetadata(rangeIgnoredBody, { format: fullFormat || undefined, inputComplete: true, totalSize }));
            }
            if (wholeResourceAvailable && head) {
                return buildResult(extractVideoMetadata(head, { inputComplete: true, totalSize }));
            }
            return buildResult({ parserState: rangeIgnoredOverLimit ? 'resource-limit' : 'unresolved', reason: 'head-unavailable' });
        }
        const format = detectVideoContainer(head);
        if (!format) return buildResult({ parserState: wholeResourceAvailable ? 'unsupported-format' : 'unresolved', format: 'unknown' });

        if (rangeIgnoredComplete && rangeIgnoredBody) {
            return buildResult(extractVideoMetadata(rangeIgnoredBody, {
                format,
                inputComplete: true,
                totalSize: rangeIgnoredBody.length,
            }));
        }

        if (format === 'webm') {
            const result = await scanWebmVideoMetadata(fetchBytes, totalSize, {
                maxBytes: VIDEO_METADATA_MAX_BYTES,
                maxReads: WEBM_MAX_RANGE_READS,
                maxTagBytes: WEBM_MAX_TAG_BYTES,
            });
            return buildResult(result);
        }

        const headComplete = totalSize !== null && head.length >= totalSize;
        let result = extractVideoMetadata(head, { format, inputComplete: headComplete, totalSize });
        if (result.parserState === 'resolved') return buildResult(result);
        if (headComplete && result.parserState === 'empty-confirmed') return buildResult(result);

        // If a moov atom begins in the head but exceeds it, fetch that atom exactly.
        if (result.moovStart !== undefined && result.moovSize > 0 && result.moovSize > VIDEO_METADATA_MAX_BYTES - totalFetched) {
            return buildResult({ parserState: 'resource-limit', reason: 'moov-byte-budget' });
        }
        if (result.moovStart !== undefined && result.moovSize > 0) {
            const moovBytes = await fetchBytes(result.moovStart, result.moovSize);
            if (moovBytes) {
                const moovResult = extractVideoMetadata(moovBytes, {
                    format,
                    startOffset: result.moovStart,
                    inputComplete: true,
                    totalSize,
                    atBoxBoundary: true,
                });
                if (['resolved', 'empty-confirmed', 'resource-limit'].includes(moovResult.parserState)) return buildResult(moovResult);
                result = moovResult;
            }
        }

        if (rangeIgnoredBody) {
            if (rangeIgnoredComplete) {
                return buildResult(extractVideoMetadata(rangeIgnoredBody, { format, inputComplete: true, totalSize }));
            }
            return buildResult({ parserState: 'unresolved', reason: rangeIgnoredOverLimit ? 'resource-limit' : 'head-incomplete' });
        }

        if (Number.isSafeInteger(totalSize) && totalSize > 0 && Number.isSafeInteger(result.nextBoxOffset)) {
            const scanResult = await scanMp4VideoMetadata(fetchBytes, totalSize, {
                startOffset: result.nextBoxOffset,
                maxBytes: Math.max(0, VIDEO_METADATA_MAX_BYTES - totalFetched),
                maxBoxes: 64,
            });
            if (['resolved', 'empty-confirmed', 'resource-limit'].includes(scanResult.parserState)) return buildResult(scanResult);
            result = scanResult;
        }
        return buildResult({
            parserState: fetchBudgetBlocked || rangeIgnoredOverLimit ? 'resource-limit' : 'unresolved',
            reason: fetchBudgetBlocked || rangeIgnoredOverLimit ? 'resource-limit' :
                rangeContentEncodingUnsupported ? 'encoded-range-unsupported' :
                    rangeRepresentationChanged ? 'range-representation-changed' :
                        rangeIdentityUnavailable ? 'range-representation-unverified' : 'metadata-not-complete',
        });
    } catch (error) {
        if (error?.name === 'TimeoutError' && !signal?.aborted) {
            debugLog({ category: 'acquisition', phase: 'background', errorType: 'timeout', urlId, retryable: true });
            return {
                success: false,
                analysisState: 'unresolved',
                diagnostics: {
                    category: 'acquisition',
                    phase: 'background',
                    errorType: 'timeout',
                    retryable: true,
                    scheme: isFile ? 'file' : undefined,
                    status: responseStatus || undefined,
                    bodyPresent: totalFetched > 0,
                },
            };
        }
        if (error?.name === 'AbortError' || signal?.aborted) {
            return { success: false, analysisState: 'failure', diagnostics: { category: 'cancelled', phase: 'background', errorType: 'abort', retryable: true } };
        }
        debugLog({ category: 'acquisition', phase: 'background', errorType: 'unknown', urlId, retryable: true });
        return { success: false, analysisState: 'unresolved', diagnostics: { category: 'acquisition', phase: 'background', errorType: 'unknown', retryable: true } };
    }
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

    // 取得開始前にschemeを一度だけ解決し、file:をHTTP取得経路から分離する。
    let parsedImageUrl = null;
    let imageScheme = '';
    try {
        parsedImageUrl = new URL(imageUrl);
        imageScheme = parsedImageUrl.protocol;
    } catch (urlError) {
        // 後続の既存取得経路で従来どおり失敗分類するため、schemeは空のままにする。
    }
    const isFileScheme = imageScheme === 'file:';
    const urlId = getSafeUrlId(imageUrl);

    debugLog('[AI Meta Viewer] Fetching metadata for:', imageUrl);
    debugLog({ category: 'acquisition', phase: 'background', event: 'request-start', urlId });

    // blob: URL は Service Worker からアクセス不可のためスキップ
    if (imageUrl.startsWith('blob:')) {
        debugLog('[AI Meta Viewer] Skipping blob: URL (not accessible from Service Worker):', imageUrl);
        return { success: true, metadata: {} };
    }

    // 1. キャッシュチェック (Async)
    const cachedMetadata = await metadataCache.get(imageUrl);
    const isSafetensorsUrl = imageUrl.toLowerCase().includes('.safetensors') || imageUrl.toLowerCase().includes('format=safetensor');
    const cachedParserState = cachedMetadata?.cacheEntryState;
    const cacheState = cachedMetadata === undefined
        ? 'miss'
        : cachedParserState === 'empty-confirmed' || cachedParserState === 'unsupported-format'
            ? 'hit-empty'
            : cachedMetadata && typeof cachedMetadata === 'object' && Object.keys(cachedMetadata).length > 0
                ? 'hit-positive'
                : 'legacy-empty-reparse';
    debugLog({ category: 'cache', phase: 'background', event: 'cache-lookup', cacheState, urlId });

    if (cachedMetadata !== undefined) {
        debugLog('[AI Meta Viewer] Cache lookup result:', {
            isSafetensorsUrl: isSafetensorsUrl,
            cachedMetadataKeys: Object.keys(cachedMetadata),
            cachedMetadataLength: Object.keys(cachedMetadata).length,
            cachedMetadata: cachedMetadata
        });

        if (cachedMetadata.cacheEntryState === 'empty-confirmed' ||
            cachedMetadata.cacheEntryState === 'unsupported-format') {
            return isFileScheme
                ? {
                    analysisState: 'confirmed-empty',
                    success: true,
                    metadata: {},
                    cached: true,
                    parserState: cachedMetadata.cacheEntryState,
                }
                : { success: true, metadata: {}, cached: true };
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
            return isFileScheme
                ? {
                    analysisState: 'resolved',
                    success: true,
                    metadata: cachedMetadata,
                    cached: true,
                }
                : { success: true, metadata: cachedMetadata, cached: true };
        }
    }

    // parser.js チェックはfile診断helper定義後に行い、失敗も状態契約へ写像する。
    let filePhase = isFileScheme ? 'acquisition' : null;
    let fileResponseStatus;
    let fileBodyPresent;
    let fileFormat = null;
    const SAFE_RESULT_FORMATS = new Set(['jpeg', 'webp', 'avif', 'png', 'safetensors', 'unknown']);
    const SAFE_RESULT_STATES = new Set([
        'resolved', 'confirmed-empty', 'empty-confirmed', 'unresolved',
        'resource-limit', 'invalid', 'failure', 'unsupported-format',
    ]);
    const SAFE_RESULT_REASONS = new Set([
        'access-denied', 'acquisition-failed', 'aborted', 'cancelled', 'timeout',
        'body-missing', 'status-error', 'read-error', 'representation-incomplete',
        'metadata-unresolved', 'parser-failure', 'scanner-failure', 'invalid-png',
        'resource-limit', 'truncated', 'structural', 'invalid-exif', 'not-found', 'unsupported-format',
        'found',
    ]);
    const SAFE_ERROR_NAMES = new Set([
        'AbortError', 'TimeoutError', 'NotAllowedError', 'SecurityError', 'NetworkError',
        'TypeError', 'ResponseStatusError', 'RepresentationMismatchError',
        'MetadataResourceLimitError', 'MetadataHeadBudgetError', 'PngScannerError', 'Error',
    ]);
    const SAFE_SCANNER_RESULT_STATUSES = new Set([
        'normal', 'stealth', 'not-found', 'invalid-png', 'resource-limit',
        'scanner-failure', 'cancelled', 'unresolved',
    ]);
    const SAFE_RESULT_CATEGORIES = new Set([
        'acquisition', 'file-access', 'representation-mismatch', 'resource-limit',
        'scanner-failure', 'parser', 'scanner', 'timeout', 'abort', 'cancelled', 'unknown',
    ]);
    const normalizeSafeCategory = (category, fallback = 'acquisition') => {
        if (SAFE_RESULT_CATEGORIES.has(category)) return category;
        if (category === 'access-denied' || category === 'file-access') return 'file-access';
        if (category === 'parser-failure') return 'parser';
        if (category === 'scanner-failure' || category === 'invalid-png') return 'scanner-failure';
        if (category === 'resource-limit') return 'resource-limit';
        return SAFE_RESULT_CATEGORIES.has(fallback) ? fallback : 'acquisition';
    };
    const normalizeSafeScannerStatus = (status) =>
        SAFE_SCANNER_RESULT_STATUSES.has(status) ? status : 'scanner-failure';
    const normalizeSafeFormat = (format) =>
        SAFE_RESULT_FORMATS.has(format) ? format : 'unknown';
    const normalizeSafeState = (state) =>
        SAFE_RESULT_STATES.has(state) ? state : 'failure';
    const normalizeSafeReason = (reason, fallback = 'acquisition-failed') => {
        if (typeof reason === 'string') {
            const value = reason.toLowerCase().replace(/[^a-z-]/g, '-');
            if (SAFE_RESULT_REASONS.has(value)) return value;
            if (value.includes('timeout') || value.includes('stall')) return 'timeout';
            if (value.includes('abort')) return 'aborted';
            if (value.includes('cancel')) return 'cancelled';
            if (value.includes('resource') || value.includes('limit')) return 'resource-limit';
            if (value.includes('truncat')) return 'truncated';
            if (value.includes('invalid')) return 'invalid-png';
            if (value.includes('parse')) return 'parser-failure';
            if (value.includes('scan')) return 'scanner-failure';
            if (value.includes('unresolved') || value.includes('incomplete')) return 'metadata-unresolved';
            if (value.includes('access') || value.includes('security')) return 'access-denied';
            if (value.includes('status')) return 'status-error';
            if (value.includes('body') || value.includes('read')) return 'read-error';
        }
        return SAFE_RESULT_REASONS.has(fallback) ? fallback : 'acquisition-failed';
    };
    const normalizeSafeErrorName = (error) =>
        SAFE_ERROR_NAMES.has(error?.name) ? error.name : 'Error';
    const classifyFileError = (error) => {
        if (error?.name === 'AbortError') {
            return error?.isTimeout || /stalled|timeout/i.test(error.message || '')
                ? 'timeout'
                : 'aborted';
        }
        if (error?.name === 'TimeoutError' || /stalled|timeout/i.test(error?.message || '')) {
            return 'timeout';
        }
        if (filePhase === 'acquisition' &&
            ['NotAllowedError', 'SecurityError', 'NetworkError'].includes(error?.name)) {
            return 'access-denied';
        }
        if (error?.name === 'MetadataResourceLimitError' ||
            error?.name === 'MetadataHeadBudgetError') return 'resource-limit';
        if (filePhase === 'scanner') return 'scanner-failure';
        if (filePhase === 'parser') return 'parser-failure';
        return 'acquisition-failed';
    };
    const createFileResult = ({
        state,
        metadata = {},
        format = fileFormat,
        parserState,
        parserReason,
        scannerStatus,
        metadataPartial = false,
        reason,
        error,
        cached = false,
    }) => {
        const analysisState = state === 'empty-confirmed' || state === 'unsupported-format'
            ? 'confirmed-empty'
            : state === 'resolved'
                ? 'resolved'
                : state === 'unresolved'
                    ? 'unresolved'
                    : 'failure';
        const safeParserState = parserState ? normalizeSafeState(parserState) : undefined;
        const safeReason = normalizeSafeReason(
            reason || parserReason || scannerStatus,
            analysisState === 'unresolved' ? 'metadata-unresolved' : 'acquisition-failed',
        );
        const diagnostic = {
            category: normalizeSafeCategory(
                error?.category || (safeReason === 'access-denied'
                    ? 'file-access'
                    : safeReason === 'timeout'
                        ? 'timeout'
                        : safeReason === 'aborted'
                            ? 'abort'
                            : safeReason === 'cancelled'
                                ? 'cancelled'
                                : safeReason === 'resource-limit'
                                    ? 'resource-limit'
                                    : filePhase === 'scanner'
                                        ? 'scanner-failure'
                                        : filePhase === 'parser'
                                            ? 'parser'
                                            : 'acquisition'),
                'acquisition',
            ),
            scheme: 'file',
            phase: filePhase || 'acquisition',
            status: typeof fileResponseStatus === 'number' ? fileResponseStatus : undefined,
            bodyPresent: fileBodyPresent === true,
            errorName: normalizeSafeErrorName(error),
            format: normalizeSafeFormat(format),
            ...(safeParserState ? { parserState: safeParserState } : {}),
            ...(scannerStatus ? { scannerStatus: normalizeSafeScannerStatus(scannerStatus) } : {}),
            reason: safeReason,
        };
        return {
            analysisState,
            success: analysisState === 'resolved' || analysisState === 'confirmed-empty',
            ...(analysisState === 'resolved' || analysisState === 'confirmed-empty'
                ? { metadata: analysisState === 'resolved' ? metadata : {} } : {}),
            format: normalizeSafeFormat(format),
            ...(safeParserState ? { parserState: safeParserState } : {}),
            ...(parserReason ? { parserReason: normalizeSafeReason(parserReason, safeReason) } : {}),
            ...(scannerStatus ? { scannerStatus: normalizeSafeScannerStatus(scannerStatus) } : {}),
            ...(metadataPartial ? { metadataPartial: true } : {}),
            reason: safeReason,
            ...(cached ? { cached: true } : {}),
            diagnostics: diagnostic,
        };
    };
    const createFileFailureResult = (error, details = {}) => createFileResult({
        state: details.analysisState || 'failure',
        format: details.format || error?.format || fileFormat,
        parserState: details.parserState || error?.parserState,
        parserReason: details.parserReason || error?.parserReason,
        scannerStatus: details.scannerStatus || error?.scannerStatus,
        reason: details.reason || error?.reason || error?.category || classifyFileError(error),
        error,
    });

    if (typeof extractMetadata !== 'function') {
        debugLog('[AI Meta Viewer] Error: extractMetadata function not found');
        return isFileScheme
            ? createFileFailureResult(new Error('Parser unavailable.'), {
                reason: 'parser-failure',
            })
            : { success: false, error: 'Parser not loaded' };
    }

    try {
        let buffer;
        let isRangeRequest = false;
        let rangeRepresentationComplete = false;
        let domain = parsedImageUrl?.hostname || '';
        let totalFileSize = 0; // 追加：Rangeリクエスト時の総サイズ保持
        // Content-Range の complete-length が `*` の場合、総サイズは不明となる。
        // 続きのRange取得は総サイズ既知と不明を区別する。
        let totalFileSizeKnown = false;
        // PNG を全body保持せず stream で受け取った場合の入力。
        // これが設定されている間は buffer を持たない。
        let pngStreamInput = null;
        let webpStreamResult = null;
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
            maxWebpScanBytes = MAX_WEBP_STREAM_SCAN_BYTES,
        } = {}) => {
            const declaredLength = getDeclaredContentLength(response.headers);
            const hasDeclaredLength = declaredLength !== null;
            const contentRange = response.status === HTTP_PARTIAL_CONTENT_STATUS
                ? parseContentRangeHeader(response.headers?.get?.('content-range'))
                : null;
            const responseInputComplete = response.status !== HTTP_PARTIAL_CONTENT_STATUS ||
                Boolean(contentRange && contentRange.start === 0 && contentRange.total !== null &&
                    contentRange.end + 1 === contentRange.total);
            const charge = declaredLength !== null && declaredLength > 0
                ? declaredLength
                : PNG_FULL_STREAM_UNKNOWN_SIZE_CHARGE_BYTES;
            const formatPrefixLimit = 12;
            const webpScanLimitBytes = Math.min(
                Number.isSafeInteger(maxWebpScanBytes) && maxWebpScanBytes > 0
                    ? maxWebpScanBytes
                    : MAX_WEBP_STREAM_SCAN_BYTES,
                MAX_WEBP_DEEP_SCAN_BYTES,
            );

            if (!response.body || typeof response.body.getReader !== 'function') {
                const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
                const bodylessPng = contentType.includes('image/png');
                const bodylessLimit = allowBodylessFileFallback
                    ? FILE_BODYLESS_FALLBACK_LIMIT
                    : bodylessPng ? BODYLESS_PNG_FALLBACK_LIMIT : FULL_FETCH_SIZE_LIMIT;
                if (!hasDeclaredLength || declaredLength > bodylessLimit) {
                    throw createMetadataSizeLimitError(
                        hasDeclaredLength ? declaredLength : bodylessLimit + 1,
                        bodylessLimit,
                    );
                }
                const fullBuffer = await response.arrayBuffer();
                if (signal?.aborted) throw createAnalysisAbortError();
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
                if (format === 'webp' && typeof createWebpMetadataStreamScanner === 'function') {
                    const scanner = createWebpMetadataStreamScanner({
                        maxMetadataBytes: METADATA_WEBP_HEAD_BUDGET_BYTES,
                        maxContainerBytes: MAX_WEBP_RIFF_SIZE_BYTES,
                    });
                    scanner.push(new Uint8Array(fullBuffer, 0, Math.min(fullBuffer.byteLength, webpScanLimitBytes)));
                    let result = scanner.finish({ inputComplete: responseInputComplete });
                    if (fullBuffer.byteLength > webpScanLimitBytes && result.complete !== true &&
                        result.state !== 'resource-limit') {
                        result = { ...result, state: 'resource-limit', complete: false, scanLimitReached: true };
                    }
                    const head = fullBuffer.slice(0, METADATA_WEBP_HEAD_BUDGET_BYTES);
                    return {
                        kind: 'buffer',
                        buffer: head,
                        webpStreamResult: result,
                        inputComplete: result.complete === true,
                        totalFileSize: fullBuffer.byteLength,
                        totalFileSizeKnown: true,
                    };
                }
                const budget = getMetadataHeadBudget(format);
                if (isBoundedMetadataFormat(format) && fullBuffer.byteLength > budget) {
                    const limited = fullBuffer.slice(0, budget);
                    const boundedMetadata = extractMetadata(limited, {
                        format,
                        inputComplete: false,
                    });
                    if (isMetadataScanComplete(boundedMetadata)) {
                        return { kind: 'buffer', buffer: limited };
                    }
                    if (boundedMetadata.metadataPartial === true && hasMetadataPayload(boundedMetadata)) {
                        return { kind: 'buffer', buffer: limited, inputComplete: false };
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
            let sourceBytesRead = 0;
            let pngPrefix = PNG_PREFIX_UNDETERMINED;
            let format = null;
            let handedOverToScanner = false;
            let boundedMetadata = null;
            let nextParseAt = 0;
            let webpScanner = null;
            let webpScannerResult = null;
            let webpBytesScanned = 0;

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
            let readerCancellationPromise = null;
            let readerReleased = false;
            let abortListener = null;
            let readerTerminationError = null;
            const rememberReaderTermination = (reason) => {
                if (reason && !readerTerminationError) readerTerminationError = reason;
            };
            const assertReaderActive = () => {
                if (readerTerminationError) throw readerTerminationError;
                if (signal?.aborted) {
                    const abortError = createAnalysisAbortError();
                    rememberReaderTermination(abortError);
                    throw abortError;
                }
            };
            const cancelReader = async (reason = null) => {
                rememberReaderTermination(reason);
                if (readerCancellationPromise) {
                    await readerCancellationPromise;
                    return;
                }
                readerCancelled = true;
                readerCancellationPromise = Promise.resolve()
                    .then(() => reader.cancel(reason))
                    .catch((error) => {
                        debugLog('[AI Meta Viewer] metadata reader cancel failed:', error);
                    });
                await readerCancellationPromise;
            };
            const releaseReader = () => {
                if (readerReleased) return;
                readerReleased = true;
                try { reader.releaseLock(); } catch (e) { debugLog('[AI Meta Viewer] metadata reader release failed:', e.message); }
            };
            if (signal) {
                abortListener = () => {
                    const abortError = createAnalysisAbortError();
                    rememberReaderTermination(abortError);
                    void cancelReader(abortError);
                };
                signal.addEventListener('abort', abortListener, { once: true });
                if (signal.aborted) abortListener();
            }
            const readWithStallTimeout = async () => {
                let timer = null;
                const timeoutPromise = new Promise((resolve, reject) => {
                    timer = setTimeout(() => {
                        const timeoutError = new Error('Metadata response stream stalled.');
                        timeoutError.name = 'TimeoutError';
                        rememberReaderTermination(timeoutError);
                        void cancelReader(timeoutError);
                        reject(timeoutError);
                    }, PNG_STREAM_STALL_TIMEOUT_MS);
                });
                try {
                    const record = await Promise.race([reader.read(), timeoutPromise]);
                    assertReaderActive();
                    return record;
                } finally {
                    if (timer !== null) clearTimeout(timer);
                }
            };

            try {
                while (true) {
                    const record = await readWithStallTimeout();
                    // cancel後のpending readがdoneで解決しても、終了理由をEOFへ変換しない。
                    assertReaderActive();
                    if (record.done) break;
                    const chunk = record.value instanceof Uint8Array
                        ? record.value
                        : new Uint8Array(record.value);
                    const chunkStart = sourceBytesRead;
                    sourceBytesRead += chunk.byteLength;

                    if (prefixLength < prefix.length) {
                        const amount = Math.min(prefix.length - prefixLength, chunk.byteLength);
                        prefix.set(chunk.subarray(0, amount), prefixLength);
                        prefixLength += amount;
                    }
                    if (pngPrefix === PNG_PREFIX_UNDETERMINED) {
                        pngPrefix = classifyPngPrefix(prefix.subarray(0, prefixLength));
                    }
                    if (pngPrefix === PNG_PREFIX_PNG) {
                        assertReaderActive();
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
                    if (format === 'webp' && typeof createWebpMetadataStreamScanner === 'function') {
                        if (!webpScanner) {
                            webpScanner = createWebpMetadataStreamScanner({
                                maxMetadataBytes: METADATA_WEBP_HEAD_BUDGET_BYTES,
                                maxContainerBytes: MAX_WEBP_RIFF_SIZE_BYTES,
                            });
                            const priorBytes = materialize();
                            if (priorBytes.byteLength > 0) {
                                webpScannerResult = webpScanner.push(priorBytes);
                                webpBytesScanned = priorBytes.byteLength;
                            }
                        }
                        const alreadyScanned = Math.max(0, webpBytesScanned - chunkStart);
                        if (alreadyScanned < chunk.byteLength && webpBytesScanned < webpScanLimitBytes) {
                            const scanLength = Math.min(
                                chunk.byteLength - alreadyScanned,
                                webpScanLimitBytes - webpBytesScanned,
                            );
                            webpScannerResult = webpScanner.push(
                                chunk.subarray(alreadyScanned, alreadyScanned + scanLength),
                            );
                            webpBytesScanned += scanLength;
                        }
                    }
                    const budget = getMetadataHeadBudget(format);
                    const remaining = budget - totalLength;
                    if (remaining <= 0 && format !== 'webp') {
                        await cancelReader();
                        throw createMetadataHeadBudgetError(totalLength, budget, format || 'unknown');
                    }
                    const accepted = chunk.byteLength > Math.max(0, remaining)
                        // budgetを跨ぐchunkは必要prefixだけを独立保持し、
                        // 元chunkの超過領域をbacking store経由で保持しない。
                        ? chunk.slice(0, Math.max(0, remaining))
                        : chunk;
                    if (accepted.byteLength > 0) chunks.push(accepted);
                    totalLength += accepted.byteLength;

                    if (format && format !== 'webp') {
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
                            if (format !== 'webp' && isMetadataScanComplete(partialMetadata)) {
                                await cancelReader();
                                assertReaderActive();
                                return { kind: 'buffer', buffer: partialBuffer };
                            }
                            nextParseAt = Math.min(
                                budget,
                                Math.max(nextParseAt * 2, nextParseAt + 4096),
                            );
                        }
                    }

                    const webpScanLimitExceeded = webpBytesScanned >= webpScanLimitBytes &&
                        (sourceBytesRead > webpBytesScanned ||
                            (hasDeclaredLength && declaredLength > webpBytesScanned));
                    if (format === 'webp' && webpScanner &&
                        (webpScanLimitExceeded || webpScannerResult?.state === 'resource-limit')) {
                        await cancelReader();
                        assertReaderActive();
                        const snapshot = webpScanner.finish({ inputComplete: responseInputComplete });
                        const result = snapshot.complete === true || snapshot.state === 'resource-limit'
                            ? snapshot
                            : { ...snapshot, state: 'resource-limit', complete: false, scanLimitReached: true };
                        return {
                            kind: 'buffer',
                            buffer: materialize(),
                            webpStreamResult: result,
                            inputComplete: result.complete === true,
                            totalFileSize: hasDeclaredLength ? declaredLength : sourceBytesRead,
                            totalFileSizeKnown: hasDeclaredLength,
                        };
                    }

                    if (format !== 'webp' && (chunk.byteLength > accepted.byteLength || totalLength >= budget)) {
                        await cancelReader();
                        if (boundedMetadata?.metadataPartial === true && hasMetadataPayload(boundedMetadata)) {
                            assertReaderActive();
                            return {
                                kind: 'buffer',
                                buffer: materialize(),
                                inputComplete: false,
                                totalFileSize: hasDeclaredLength ? declaredLength : sourceBytesRead,
                                totalFileSizeKnown: hasDeclaredLength,
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
            assertReaderActive();
            const buffer = materialize();
            if (!format && prefixLength >= 3) {
                format = detectImageFormat(buffer);
            }
            if (format === 'webp') {
                let result = webpScanner?.finish({ inputComplete: responseInputComplete }) || webpScannerResult;
                if (webpBytesScanned >= webpScanLimitBytes && result?.complete !== true &&
                    result?.state !== 'resource-limit') {
                    result = { ...result, state: 'resource-limit', complete: false, scanLimitReached: true };
                }
                return {
                    kind: 'buffer',
                    buffer,
                    webpStreamResult: result || null,
                    inputComplete: result?.complete === true,
                    totalFileSize: hasDeclaredLength ? declaredLength : sourceBytesRead,
                    totalFileSizeKnown: hasDeclaredLength,
                };
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
            assertReaderActive();
            return { kind: 'buffer', buffer };
        };


        /**
         * file://専用の bounded reader。
         * HTTPのRangeや再試行を使わず、非PNGは形式別の保持量だけを維持する。
         * @param {Response} response - file://の応答
         * @param {Object} options - reader設定
         * @returns {Promise<Object>} - bounded input
         */
        const readFileResponseForMetadata = async (response, {
            imageUrl: localImageUrl,
            signal = null,
            maxWebpScanBytes = MAX_WEBP_STREAM_SCAN_BYTES,
        } = {}) => {
            const declaredLength = getDeclaredContentLength(response.headers);
            const hasDeclaredLength = declaredLength !== null;
            const webpScanLimitBytes = Math.min(
                Number.isSafeInteger(maxWebpScanBytes) && maxWebpScanBytes > 0
                    ? maxWebpScanBytes
                    : MAX_WEBP_STREAM_SCAN_BYTES,
                MAX_WEBP_DEEP_SCAN_BYTES,
            );
            const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
            const urlLower = String(localImageUrl || '').toLowerCase();
            const formatHint = contentType.includes('png') || urlLower.endsWith('.png')
                ? 'png'
                : contentType.includes('webp') || urlLower.endsWith('.webp')
                    ? 'webp'
                    : contentType.includes('jpeg') || contentType.includes('jpg') ||
                        /\.(?:jpe?g)(?:[?#]|$)/i.test(urlLower)
                        ? 'jpeg'
                        : contentType.includes('avif') || urlLower.endsWith('.avif')
                            ? 'avif'
                            : contentType.includes('safetensor') || urlLower.includes('.safetensors')
                                ? 'safetensors'
                                : null;
            const localPngLimit = PNG_FULL_STREAM_INFLIGHT_BUDGET_BYTES;
            const getLocalLimit = (format) => {
                switch (format) {
                    case 'jpeg':
                    case 'avif':
                        return METADATA_JPEG_HEAD_BUDGET_BYTES;
                    case 'webp':
                        return MAX_WEBP_BODYLESS_BUFFER_BYTES;
                    case 'safetensors':
                        return METADATA_SAFETENSORS_HEAD_BUDGET_BYTES;
                    case 'png':
                        return localPngLimit;
                    default:
                        // Bodyless応答は読み込み前にsignatureを調べられないため、
                        // 形式不明時は対応形式の最大上限まで検出用に読む。
                        return METADATA_SAFETENSORS_HEAD_BUDGET_BYTES;
                }
            };
            const localHeadLimit = (format) => {
                switch (format) {
                    case 'jpeg':
                    case 'avif':
                        return METADATA_JPEG_HEAD_BUDGET_BYTES;
                    case 'webp':
                        return METADATA_WEBP_HEAD_BUDGET_BYTES;
                    case 'safetensors':
                        return METADATA_SAFETENSORS_HEAD_BUDGET_BYTES;
                    default:
                        return METADATA_SAFETENSORS_HEAD_BUDGET_BYTES;
                }
            };

            if (!response.body || typeof response.body.getReader !== 'function') {
                const preReadLimit = getLocalLimit(formatHint);
                if (!hasDeclaredLength || declaredLength > preReadLimit) {
                    throw createMetadataSizeLimitError(
                        hasDeclaredLength ? declaredLength : preReadLimit + 1,
                        preReadLimit,
                    );
                }
                if (typeof response.arrayBuffer !== 'function') {
                    throw new Error('File response body is unavailable.');
                }
                const fullBuffer = await response.arrayBuffer();
                if (signal?.aborted) throw createAnalysisAbortError();
                if (!(fullBuffer instanceof ArrayBuffer) || fullBuffer.byteLength === 0) {
                    throw new Error('File response body is empty.');
                }
                if (fullBuffer.byteLength > declaredLength || fullBuffer.byteLength > preReadLimit) {
                    throw createMetadataSizeLimitError(fullBuffer.byteLength, preReadLimit);
                }
                const bytes = new Uint8Array(fullBuffer);
                const format = detectImageFormat(bytes);
                const detectedLimit = getLocalLimit(format || formatHint);
                if (fullBuffer.byteLength > detectedLimit) {
                    throw createMetadataSizeLimitError(fullBuffer.byteLength, detectedLimit);
                }
                if (format === 'png') {
                    return {
                        kind: 'png-buffer',
                        buffer: fullBuffer,
                        // 宣言長がないbodyless応答は、stream経路と同じ未知長chargeを使う。
                        charge: hasDeclaredLength
                            ? declaredLength
                            : PNG_FULL_STREAM_UNKNOWN_SIZE_CHARGE_BYTES,
                        gateRequired: true,
                    };
                }
                if (format === 'webp' && typeof createWebpMetadataStreamScanner === 'function') {
                    const scanner = createWebpMetadataStreamScanner({
                        maxMetadataBytes: METADATA_WEBP_HEAD_BUDGET_BYTES,
                        maxContainerBytes: MAX_WEBP_RIFF_SIZE_BYTES,
                    });
                    scanner.push(bytes.subarray(0, Math.min(bytes.byteLength, webpScanLimitBytes)));
                    const result = scanner.finish();
                    const head = bytes.slice(0, METADATA_WEBP_HEAD_BUDGET_BYTES);
                    return {
                        kind: 'buffer',
                        buffer: head.buffer,
                        webpStreamResult: result,
                        inputComplete: result.complete === true,
                        totalFileSize: bytes.byteLength,
                        totalFileSizeKnown: true,
                    };
                }
                const budget = localHeadLimit(format || formatHint);
                if (bytes.byteLength > budget) {
                    const limited = bytes.slice(0, budget);
                    const boundedMetadata = format
                        ? extractMetadata(limited, { format, inputComplete: false })
                        : null;
                    if (boundedMetadata && isMetadataScanComplete(boundedMetadata)) {
                        return {
                            kind: 'buffer',
                            buffer: limited.buffer,
                            inputComplete: false,
                            totalFileSize: bytes.byteLength,
                            totalFileSizeKnown: true,
                        };
                    }
                    if (boundedMetadata?.metadataPartial === true && hasMetadataPayload(boundedMetadata)) {
                        return {
                            kind: 'buffer',
                            buffer: limited.buffer,
                            inputComplete: false,
                            totalFileSize: bytes.byteLength,
                            totalFileSizeKnown: true,
                        };
                    }
                    throw createMetadataHeadBudgetError(bytes.byteLength, budget, format || 'unknown');
                }
                return {
                    kind: 'buffer',
                    buffer: fullBuffer,
                    inputComplete: true,
                    totalFileSize: fullBuffer.byteLength,
                    totalFileSizeKnown: true,
                };
            }

            const reader = response.body.getReader();
            const headChunks = [];
            const prefix = new Uint8Array(12);
            let prefixLength = 0;
            let headLength = 0;
            let totalLength = 0;
            let format = null;
            let handedOverToScanner = false;
            let webpHeadFinalized = false;
            let webpScanner = null;
            let webpScannerResult = null;
            let webpBytesScanned = 0;
            let readerCancellationPromise = null;
            const prefixChunks = [];
            let readerReleased = false;
            let terminationError = null;
            let abortListener = null;

            const rememberTermination = (error) => {
                if (error && !terminationError) terminationError = error;
            };
            const cancelReader = async (reason = null) => {
                rememberTermination(reason);
                if (readerCancellationPromise) {
                    await readerCancellationPromise;
                    return;
                }
                readerCancellationPromise = Promise.resolve()
                    .then(() => reader.cancel(reason))
                    .catch(() => { });
                await readerCancellationPromise;
            };
            const releaseReader = () => {
                if (readerReleased) return;
                readerReleased = true;
                try { reader.releaseLock(); } catch (error) { /* lock解放済み */ }
            };
            const assertActive = () => {
                if (terminationError) throw terminationError;
                if (signal?.aborted) {
                    const error = createAnalysisAbortError();
                    rememberTermination(error);
                    throw error;
                }
            };
            const materialize = (chunks, length) => {
                const result = new Uint8Array(length);
                let offset = 0;
                for (const chunk of chunks) {
                    result.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                return result;
            };
            const appendHead = (value, limit) => {
                const remaining = limit - headLength;
                if (remaining <= 0) return value;
                const acceptedLength = Math.min(value.byteLength, remaining);
                if (acceptedLength > 0) {
                    headChunks.push(value.slice(0, acceptedLength));
                    headLength += acceptedLength;
                }
                return value.slice(acceptedLength);
            };
            const detectLocalFormat = () => {
                if (prefixLength < 3) return null;
                const detailed = typeof detectImageFormatDetailed === 'function'
                    ? detectImageFormatDetailed(prefix.subarray(0, prefixLength))
                    : { format: detectImageFormat(prefix.subarray(0, prefixLength)) };
                return detailed?.format || null;
            };
            const checkWebpDeclaredSize = (bytes) => {
                if (bytes.length < 12 || bytes[0] !== 0x52 || bytes[1] !== 0x49 ||
                    bytes[2] !== 0x46 || bytes[3] !== 0x46 || bytes[8] !== 0x57 ||
                    bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50) return;
                const declared = getDeclaredWebpSize(bytes);
                if (!Number.isSafeInteger(declared) || declared > MAX_WEBP_RIFF_SIZE_BYTES) {
                    throw createMetadataSizeLimitError(
                        Number.isSafeInteger(declared) ? declared : MAX_WEBP_RIFF_SIZE_BYTES + 1,
                        MAX_WEBP_RIFF_SIZE_BYTES,
                    );
                }
                if (hasDeclaredLength && declared > MAX_WEBP_RIFF_SIZE_BYTES) {
                    throw createMetadataSizeLimitError(declaredLength, MAX_WEBP_RIFF_SIZE_BYTES);
                }
            };
            const repartitionHead = () => {
                const allHead = materialize(headChunks, headLength);
                if (format === 'webp') {
                    checkWebpDeclaredSize(allHead);
                    const boundedHead = allHead.subarray(0, METADATA_WEBP_HEAD_BUDGET_BYTES);
                    headChunks.length = 0;
                    headChunks.push(boundedHead.slice());
                    headLength = boundedHead.byteLength;
                    return;
                }
                const budget = localHeadLimit(format);
                if (allHead.byteLength > budget) {
                    headChunks.length = 0;
                    headChunks.push(allHead.slice(0, budget));
                    headLength = budget;
                }
            };
            const parseHead = (inputComplete) => {
                if (!format || format === 'png' || headLength === 0) return null;
                const parsed = extractMetadata(materialize(headChunks, headLength).buffer, {
                    format,
                    inputComplete,
                });
                if (format === 'webp') checkWebpDeclaredSize(materialize(headChunks, headLength));
                return parsed;
            };
            const feedWebpScanner = (chunk, copiedFromChunk) => {
                if (format !== 'webp' || typeof createWebpMetadataStreamScanner !== 'function') return;
                const pushWebpBytes = (bytes) => {
                    const remaining = webpScanLimitBytes - webpBytesScanned;
                    if (remaining <= 0 || bytes.byteLength === 0) return;
                    const accepted = bytes.subarray(0, Math.min(bytes.byteLength, remaining));
                    webpScannerResult = webpScanner.push(accepted);
                    webpBytesScanned += accepted.byteLength;
                };
                if (!webpScanner) {
                    webpScanner = createWebpMetadataStreamScanner({
                        maxMetadataBytes: METADATA_WEBP_HEAD_BUDGET_BYTES,
                        maxContainerBytes: MAX_WEBP_RIFF_SIZE_BYTES,
                    });
                    const priorPrefix = materialize(prefixChunks, prefixLength);
                    if (priorPrefix.byteLength > 0) {
                        pushWebpBytes(priorPrefix);
                    }
                    if (copiedFromChunk < chunk.byteLength) {
                        pushWebpBytes(chunk.subarray(copiedFromChunk));
                    }
                    return;
                }
                pushWebpBytes(chunk);
            };
            const readWithTimeout = async () => {
                let timer = null;
                const timeoutPromise = new Promise((resolve, reject) => {
                    timer = setTimeout(() => {
                        const error = new Error('File metadata response stream stalled.');
                        error.name = 'TimeoutError';
                        rememberTermination(error);
                        void cancelReader(error);
                        reject(error);
                    }, PNG_STREAM_STALL_TIMEOUT_MS);
                });
                try {
                    const record = await Promise.race([reader.read(), timeoutPromise]);
                    assertActive();
                    return record;
                } finally {
                    if (timer !== null) clearTimeout(timer);
                }
            };

            if (signal) {
                abortListener = () => {
                    const error = createAnalysisAbortError();
                    rememberTermination(error);
                    void cancelReader(error);
                };
                signal.addEventListener('abort', abortListener, { once: true });
            }

            try {
                while (true) {
                    const record = await readWithTimeout();
                    assertActive();
                    if (record.done) break;
                    const chunk = record.value instanceof Uint8Array
                        ? record.value
                        : new Uint8Array(record.value);
                    if (chunk.byteLength === 0) continue;
                    totalLength += chunk.byteLength;
                    let copiedFromChunk = 0;
                    if (prefixLength < prefix.byteLength) {
                        copiedFromChunk = Math.min(prefix.byteLength - prefixLength, chunk.byteLength);
                        prefixChunks.push(chunk.slice(0, copiedFromChunk));
                        prefix.set(chunk.subarray(0, copiedFromChunk), prefixLength);
                        prefixLength += copiedFromChunk;
                    }
                    if (!format) {
                        format = detectLocalFormat();
                        if (format === 'png') {
                            if (prefixLength < PNG_SIGNATURE.length ||
                                classifyPngPrefix(prefix.subarray(0, prefixLength)) !== PNG_PREFIX_PNG) {
                                throw createRepresentationMismatchError(prefix.subarray(0, prefixLength));
                            }
                            const replayChunks = prefixChunks.slice();
                            const remainder = chunk.slice(copiedFromChunk);
                            if (remainder.byteLength > 0) replayChunks.push(remainder);
                            handedOverToScanner = true;
                            return {
                                kind: 'png-stream',
                                stream: createReplayStream(replayChunks, reader),
                                charge: hasDeclaredLength && declaredLength > 0
                                    ? declaredLength
                                    : PNG_FULL_STREAM_UNKNOWN_SIZE_CHARGE_BYTES,
                            };
                        }
                    }
                    if (format === 'webp') {
                        checkWebpDeclaredSize(prefix.subarray(0, prefixLength));
                        feedWebpScanner(chunk, copiedFromChunk);
                    }
                    const storageLimit = format ? localHeadLimit(format) : METADATA_SAFETENSORS_HEAD_BUDGET_BYTES;
                    if (format === 'webp') {
                        appendHead(chunk, storageLimit);
                        if (!webpHeadFinalized && headLength >= METADATA_WEBP_HEAD_BUDGET_BYTES) {
                            repartitionHead();
                            webpHeadFinalized = true;
                        }
                    } else {
                        const overflow = appendHead(chunk, storageLimit);
                        if (overflow.byteLength > 0) {
                            const partial = parseHead(false);
                            if (!isMetadataScanComplete(partial)) {
                                await cancelReader();
                                if (partial?.metadataPartial === true && hasMetadataPayload(partial)) {
                                    return {
                                        kind: 'buffer',
                                        buffer: materialize(headChunks, headLength).buffer,
                                        inputComplete: false,
                                        totalFileSize: hasDeclaredLength ? declaredLength : totalLength,
                                        totalFileSizeKnown: hasDeclaredLength,
                                    };
                                }
                                throw createMetadataHeadBudgetError(headLength, storageLimit, format || 'unknown');
                            }
                        }
                    }
                    if (format && format !== 'webp' && headLength >= storageLimit) {
                        const partial = parseHead(false);
                        if (isMetadataScanComplete(partial)) {
                            await cancelReader();
                            return {
                                kind: 'buffer',
                                buffer: materialize(headChunks, headLength).buffer,
                                inputComplete: true,
                                totalFileSize: totalLength,
                                totalFileSizeKnown: hasDeclaredLength,
                            };
                        }
                        if (partial?.metadataPartial === true && hasMetadataPayload(partial)) {
                            await cancelReader();
                            return {
                                kind: 'buffer',
                                buffer: materialize(headChunks, headLength).buffer,
                                inputComplete: false,
                                totalFileSize: hasDeclaredLength ? declaredLength : totalLength,
                                totalFileSizeKnown: hasDeclaredLength,
                            };
                        }
                    }
                    if (!format && headLength >= METADATA_SAFETENSORS_HEAD_BUDGET_BYTES) {
                        await cancelReader();
                        throw createMetadataHeadBudgetError(headLength, METADATA_SAFETENSORS_HEAD_BUDGET_BYTES, 'unknown');
                    }
                    if (hasDeclaredLength && totalLength > declaredLength) {
                        await cancelReader();
                        throw new Error('File response exceeded its declared length.');
                    }
                    const webpScanLimitExceeded = webpBytesScanned >= webpScanLimitBytes &&
                        (totalLength > webpBytesScanned ||
                            (hasDeclaredLength && declaredLength > webpBytesScanned));
                    if (format === 'webp' &&
                        (webpScanLimitExceeded || webpScannerResult?.state === 'resource-limit')) {
                        const snapshot = webpScanner?.finish() || webpScannerResult;
                        const result = snapshot?.complete === true || snapshot?.state === 'resource-limit'
                            ? snapshot
                            : { ...snapshot, state: 'resource-limit', complete: false, scanLimitReached: true };
                        return {
                            kind: 'buffer',
                            buffer: materialize(headChunks, headLength).buffer,
                            webpStreamResult: result || null,
                            inputComplete: result?.complete === true,
                            totalFileSize: hasDeclaredLength ? declaredLength : totalLength,
                            totalFileSizeKnown: hasDeclaredLength,
                        };
                    }
                }

                assertActive();
                if (!format) format = detectImageFormat(materialize(headChunks, headLength));
                if (format === 'webp') {
                    let result = webpScanner?.finish() || webpScannerResult;
                    if (webpBytesScanned >= webpScanLimitBytes && result?.complete !== true &&
                        result?.state !== 'resource-limit') {
                        result = { ...result, state: 'resource-limit', complete: false, scanLimitReached: true };
                    }
                    const head = materialize(headChunks, headLength);
                    return {
                        kind: 'buffer',
                        buffer: head.buffer,
                        webpStreamResult: result || null,
                        inputComplete: result?.complete === true,
                        totalFileSize: hasDeclaredLength ? declaredLength : totalLength,
                        totalFileSizeKnown: hasDeclaredLength,
                    };
                }
                const finalBuffer = materialize(headChunks, headLength);
                if (format) {
                    // JPEG/AVIFは既存parserのSOS/meta box完了条件を優先し、
                    // SafetensorsだけはEOFをtruncated判定へ渡す。
                    const parserInputComplete = format === 'safetensors';
                    const parsed = extractMetadata(finalBuffer.buffer, {
                        format,
                        inputComplete: parserInputComplete,
                    });
                    if (getMetadataState(parsed) === 'unresolved' &&
                        format === 'safetensors') {
                        throw createMetadataHeadBudgetError(
                            headLength,
                            localHeadLimit(format),
                            format,
                        );
                    }
                    const parserComplete = getMetadataState(parsed) !== 'unresolved';
                    return {
                        kind: 'buffer',
                        buffer: finalBuffer.buffer,
                        inputComplete: parserComplete,
                        totalFileSize: totalLength,
                        totalFileSizeKnown: hasDeclaredLength,
                    };
                } else if (totalLength > FULL_FETCH_SIZE_LIMIT) {
                    throw createMetadataSizeLimitError(totalLength, FULL_FETCH_SIZE_LIMIT);
                }
                return {
                    kind: 'buffer',
                    buffer: finalBuffer.buffer,
                    inputComplete: true,
                    totalFileSize: totalLength,
                    totalFileSizeKnown: hasDeclaredLength,
                };
            } finally {
                if (signal && abortListener) signal.removeEventListener('abort', abortListener);
                if (!handedOverToScanner) {
                    await cancelReader(terminationError);
                    releaseReader();
                }
            }
        };

        /**
         * 全取得のヘッダー待ちを制限し、応答本文の読取中は親のAbortSignalを維持する。
         * @param {string} url - 取得URL
         * @param {AbortSignal|null} signal - 親解析のAbortSignal
         * @param {Function} consumeResponse - responseと合成signalを受け取る本文処理
         * @returns {Promise<*>} - 本文処理の結果
         */
        const withFullFetchHeadersTimeout = async (url, signal, consumeResponse) => {
            const controller = new AbortController();
            let timedOut = false;
            let timeoutId = null;
            const abortFromAnalysis = () => controller.abort();
            const createHeadersTimeoutError = () => {
                const error = new Error(`Full fetch response headers timed out after ${FULL_FETCH_HEADERS_TIMEOUT_MS}ms.`);
                error.name = 'TimeoutError';
                return error;
            };

            if (signal?.aborted) throw createAnalysisAbortError();
            if (signal) signal.addEventListener('abort', abortFromAnalysis, { once: true });
            timeoutId = setTimeout(() => {
                timedOut = true;
                controller.abort();
            }, FULL_FETCH_HEADERS_TIMEOUT_MS);

            try {
                let response;
                try {
                    response = await fetch(url, { redirect: 'follow', signal: controller.signal });
                } catch (error) {
                    if (signal?.aborted) throw createAnalysisAbortError();
                    if (timedOut) throw createHeadersTimeoutError();
                    throw error;
                }
                if (signal?.aborted) throw createAnalysisAbortError();
                if (timedOut) throw createHeadersTimeoutError();
                clearTimeout(timeoutId);
                timeoutId = null;
                return await consumeResponse(response, controller.signal);
            } finally {
                if (timeoutId !== null) clearTimeout(timeoutId);
                if (signal) signal.removeEventListener('abort', abortFromAnalysis);
            }
        };

        /**
         * 初期取得用の全取得 Fetch。PNGはstreamで受け取れる。
         * @param {string} url - 取得URL
         * @returns {Promise<Object>} - readResponseForMetadata の結果
         */
        const safeFetchFullInput = (url, signal = null, options = {}) => withFullFetchHeadersTimeout(
            url,
            signal,
            (response, requestSignal) => {
                if (response.status !== HTTP_OK_STATUS) throw new Error(`HTTP ${response.status}`);
                return readResponseForMetadata(response, {
                    allowPngStream: true,
                    signal: requestSignal,
                    maxWebpScanBytes: options.maxWebpScanBytes,
                });
            }
        );

        const safeFetchFullWebpInput = async (url, signal = null, { deepScan = false } = {}) => {
            const readFullWebpInput = async (maxWebpScanBytes) => {
                if (!isFileScheme) {
                    return safeFetchFullInput(url, signal, { maxWebpScanBytes });
                }
                const response = await fetch(url, { redirect: 'follow', signal });
                if (!response || response.status !== HTTP_OK_STATUS) {
                    throw new Error(`WebP full scan failed with HTTP ${response?.status ?? 'unknown'}.`);
                }
                return readFileResponseForMetadata(response, {
                    imageUrl: url,
                    signal,
                    maxWebpScanBytes,
                });
            };

            const input = await readFullWebpInput(
                deepScan ? MAX_WEBP_DEEP_SCAN_BYTES : MAX_WEBP_STREAM_SCAN_BYTES,
            );
            if (!deepScan && input.webpStreamResult?.scanLimitReached === true) {
                return readFullWebpInput(MAX_WEBP_DEEP_SCAN_BYTES);
            }
            return input;
        };

        /**
         * 非PNG経路の再試行用の全取得 Fetch。buffer だけを返す。
         * この経路は既に非PNGと判定された画像にだけ使われるため、
         * PNG が返った場合は representation drift として失敗させる。
         * @param {string} url - 取得URL
         * @returns {Promise<ArrayBuffer>}
         */
        const safeFetchFull = (url, signal = null) => withFullFetchHeadersTimeout(
            url,
            signal,
            async (response, requestSignal) => {
                if (response.status !== HTTP_OK_STATUS) throw new Error(`HTTP ${response.status}`);
                const input = await readResponseForMetadata(response, {
                    allowPngStream: false,
                    signal: requestSignal,
                });
                if (input.kind === 'png-buffer') {
                    throw createRepresentationMismatchError(
                        new Uint8Array(input.buffer).subarray(0, PNG_SIGNATURE.length)
                    );
                }
                return input.buffer;
            }
        );

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
                const input = await readFileResponseForMetadata(response, {
                    imageUrl,
                    signal: fileController.signal,
                });
                if (input.kind === 'png-stream') {
                    pngStreamInput = input;
                    rangeRepresentationComplete = true;
                } else {
                    buffer = input.buffer;
                    webpStreamResult = input.webpStreamResult || null;
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
                            if (analysisSignal?.aborted) throw createAnalysisAbortError();
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
                                webpStreamResult = input.webpStreamResult || webpStreamResult;
                                pngBufferRequiresGate = input.gateRequired === true;
                                pngBufferCharge = input.charge || PNG_FULL_STREAM_UNKNOWN_SIZE_CHARGE_BYTES;
                                totalFileSizeKnown = input.totalFileSizeKnown !== false;
                                totalFileSize = totalFileSizeKnown
                                    ? (input.totalFileSize || buffer.byteLength)
                                    : buffer.byteLength;
                                // 続きの取得が必要な場合だけRange再試行へ接続する。
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
                    if (analysisSignal?.aborted) throw createAnalysisAbortError();

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
                        webpStreamResult = fallbackInput.webpStreamResult || webpStreamResult;
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
                    webpStreamResult = blockedInput.webpStreamResult || webpStreamResult;
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
        if (isFileScheme) fileFormat = detectedFormat;
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
                                    if (signal?.aborted) throw createAnalysisAbortError();
                                    const record = await reader.read();
                                    if (signal?.aborted) throw createAnalysisAbortError();
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
                                if (signal?.aborted) throw createAnalysisAbortError();
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
                        if (signal?.aborted) throw createAnalysisAbortError();
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
            if (analysisSignal?.aborted) throw createAnalysisAbortError();
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
                scanResult = scanPngMetadataBuffer(buffer, { signal: analysisSignal });
            } else {
                // partial headは後続断片へ接続せず、byte 0からのstreamだけを解析する。
                buffer = null;
                scanResult = await scanPngFromByteZero(activeUrl);
            }

            if (analysisSignal?.aborted) throw createAnalysisAbortError();
            if (scanResult.status === 'normal' || scanResult.status === 'stealth') {
                if (analysisSignal?.aborted) throw createAnalysisAbortError();
                const cacheResult = scanResult.metadataPartial === true
                    ? null
                    : await metadataCache.set(
                        imageUrl,
                        scanResult.metadata,
                        { scannerVersion: PNG_SCANNER_CACHE_VERSION },
                    );
                if (!isFileScheme && cacheResult && cacheResult.reason === 'size-limit') {
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
                if (isFileScheme) {
                    return createFileResult({
                        state: 'resolved',
                        format: 'png',
                        metadata: scanResult.metadata,
                        scannerStatus: scanResult.status,
                        metadataPartial: scanResult.metadataPartial === true,
                        reason: 'found',
                    });
                }
                return {
                    success: true,
                    metadata: scanResult.metadata,
                    ...(scanResult.metadataPartial === true ? { metadataPartial: true } : {}),
                    diagnostics: scanResult.diagnostics,
                };
            }
            if (scanResult.status === 'not-found') {
                // IENDまで到達したnot-foundだけを、版数付きnegative cacheへ保存する。
                if (analysisSignal?.aborted) throw createAnalysisAbortError();
                await metadataCache.set(imageUrl, {}, {
                    scannerVersion: PNG_SCANNER_CACHE_VERSION,
                    parserState: 'empty-confirmed',
                });
                if (isFileScheme) {
                    return createFileResult({
                        state: 'empty-confirmed',
                        format: 'png',
                        parserState: 'empty-confirmed',
                        scannerStatus: scanResult.status,
                        reason: 'not-found',
                    });
                }
                return {
                    success: true,
                    metadata: {},
                    diagnostics: scanResult.diagnostics,
                };
            }

            if (scanResult.status === 'unresolved') {
                if (isFileScheme) {
                    return createFileResult({
                        state: 'unresolved',
                        format: 'png',
                        parserState: 'unresolved',
                        scannerStatus: 'unresolved',
                        reason: scanResult.reason || 'metadata-unresolved',
                    });
                }
                return {
                    success: false,
                    analysisState: 'unresolved',
                    parserState: 'unresolved',
                    error: 'PNG metadata scan is incomplete.',
                    diagnostics: scanResult.diagnostics,
                };
            }

            const reason = scanResult.reason || scanResult.limit || scanResult.status;
            if (isFileScheme) {
                const scannerError = new Error('PNG scanner failed.');
                scannerError.name = 'PngScannerError';
                scannerError.category = scanResult.status === 'resource-limit'
                    ? 'resource-limit'
                    : 'scanner-failure';
                scannerError.format = 'png';
                scannerError.scannerStatus = scanResult.status;
                scannerError.reason = reason;
                return createFileFailureResult(scannerError, {
                    format: 'png',
                    scannerStatus: scanResult.status,
                    reason,
                });
            }
            return {
                success: false,
                error: `PNG scan failed: ${reason}`,
                diagnostics: scanResult.diagnostics,
            };
        }

        let metadata = {};
        let fullFetchFallbackAttempted = false;
        const fetchFullAndParse = async () => {
            if (fullFetchFallbackAttempted) {
                throw new Error('Full fetch fallback was already attempted.');
            }
            fullFetchFallbackAttempted = true;
            // Mark the fallback before awaiting it so an outer catch cannot download
            // the same full representation again when this attempt fails.
            isRangeRequest = false;
            const fullBuffer = await safeFetchFull(activeUrl, getAnalysisContext(imageUrl)?.signal);
            buffer = fullBuffer;
            totalFileSize = fullBuffer.byteLength;
            totalFileSizeKnown = true;
            rangeRepresentationComplete = true;
            metadata = extractMetadata(fullBuffer, {
                format: detectedFormat,
                inputComplete: true,
            });
            return metadata;
        };
        try {
            metadata = extractMetadata(buffer, {
                format: detectedFormat,
                inputComplete: rangeRepresentationComplete,
            });

            if (detectedFormat === 'webp' && webpStreamResult) {
                metadata = mergeWebpStreamMetadata(metadata, webpStreamResult);
            }

            const webpNeedsRecovery = detectedFormat === 'webp' &&
                (getMetadataState(metadata) === 'unresolved' || metadata.metadataPartial === true ||
                    webpStreamResult?.scanLimitReached === true) &&
                (!webpStreamResult || webpStreamResult.complete !== true) &&
                (webpStreamResult?.state !== 'resource-limit' || webpStreamResult?.scanLimitReached === true);
            if (webpNeedsRecovery) {
                try {
                    const fullInput = await safeFetchFullWebpInput(
                        activeUrl,
                        getAnalysisContext(imageUrl)?.signal,
                        { deepScan: webpStreamResult?.scanLimitReached === true },
                    );
                    if (fullInput.kind === 'png-stream') {
                        if (fullInput.stream?.cleanup) await fullInput.stream.cleanup();
                        throw createRepresentationMismatchError(new Uint8Array(0));
                    }
                    buffer = fullInput.buffer;
                    webpStreamResult = fullInput.webpStreamResult || null;
                    totalFileSize = fullInput.totalFileSize || buffer.byteLength;
                    totalFileSizeKnown = fullInput.totalFileSizeKnown !== false;
                    rangeRepresentationComplete = fullInput.inputComplete === true;
                    metadata = extractMetadata(buffer, {
                        format: detectedFormat,
                        inputComplete: rangeRepresentationComplete,
                    });
                    metadata = mergeWebpStreamMetadata(metadata, webpStreamResult);
                    isRangeRequest = false;
                } catch (webpScanError) {
                    debugLog('[AI Meta Viewer] ⚠ WebP structural scan failed:', webpScanError.message);
                }
            }

            // メタデータ不足時の再試行ロジック
            if (getMetadataState(metadata) === 'unresolved' && !isFileScheme && detectedFormat !== 'webp') {

                if (!isRangeRequest) {
                    // file:// URL 等で Range が暗黙的に効いてバッファが切り詰められたケース
                    // safeFetchFull で全ファイルを取得して再解析
                    debugLog('[AI Meta Viewer] ⚠ Metadata incomplete but not a Range request. Attempting full fetch fallback.');
                    try {
                        await fetchFullAndParse();

                        // full fetch 成功後、完全なメタデータが取得できた場合は以降の再試行をスキップ
                        if (getMetadataState(metadata) !== 'unresolved') {
                            debugLog('[AI Meta Viewer] ✅ Full fetch successful, metadata complete.');
                            // isRangeRequest は false のまま（Stealth PNG チェックでの重複ダウンロードを防ぐ）
                        } else {
                            // まだ incomplete の場合のみ、Range再試行を有効化
                            isRangeRequest = true;
                        }
                    } catch (fullFetchError) {
                        debugLog('[AI Meta Viewer] ⚠ Full fetch fallback failed:', fullFetchError.message);
                    }
                }

                // full fetch 後も metadata.isIncomplete を再チェック
                // 完全なメタデータが取得できた場合は以降の再試行をスキップ
                if (getMetadataState(metadata) === 'unresolved') {
                    const requestedRetryEnd = Number.isSafeInteger(metadata.suggestedSize) && metadata.suggestedSize > 0
                        ? metadata.suggestedSize
                        : 131072;
                    const maxRetryEnd = isBoundedMetadataFormat(detectedFormat)
                        ? getMetadataHeadBudget(detectedFormat) - 1
                        : FULL_FETCH_SIZE_LIMIT - 1;
                    const retrySize = Math.min(Math.max(0, requestedRetryEnd), maxRetryEnd);
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
                                const retryRange = parseContentRangeHeader(
                                    retryResponse.headers?.get?.('Content-Range')
                                );
                                if (!retryRange || retryRange.start !== 0 || retryRange.end > retrySize) {
                                    try { await retryResponse.body?.cancel?.(); } catch (_) { }
                                    throw new Error('Invalid or over-delivered Content-Range for metadata retry.');
                                }
                                const newBuffer = await retryResponse.arrayBuffer();
                                if (newBuffer.byteLength !== retryRange.length) {
                                    throw new Error('Content-Range length does not match retry body length.');
                                }
                                const retryComplete = retryRange.total !== null &&
                                    retryRange.start === 0 && retryRange.end + 1 === retryRange.total &&
                                    retryRange.length === retryRange.total;
                                const nextMetadata = extractMetadata(newBuffer, {
                                    format: detectedFormat,
                                    inputComplete: retryComplete,
                                });
                                const retryState = getMetadataState(nextMetadata);
                                const budgetReached = isBoundedMetadataFormat(detectedFormat) &&
                                    newBuffer.byteLength >= getMetadataHeadBudget(detectedFormat);
                                if (retryState === 'unresolved' && !budgetReached &&
                                    !fullFetchFallbackAttempted) {
                                    debugLog('[AI Meta Viewer] ⚠ Still incomplete. Falling back to safe full fetch.');
                                    await fetchFullAndParse();
                                } else {
                                    buffer = newBuffer;
                                    metadata = nextMetadata;
                                }
                            } else if (retryResponse.status === HTTP_OK_STATUS) {
                                const retryInput = await readResponseForMetadata(retryResponse, {
                                    allowPngStream: false,
                                    signal: analysisSignal,
                                });
                                if (retryInput.kind === 'png-stream' || retryInput.kind === 'png-buffer') {
                                    throw createRepresentationMismatchError(
                                        new Uint8Array(retryInput.buffer || new ArrayBuffer(0)).subarray(0, PNG_SIGNATURE.length)
                                    );
                                }
                                buffer = retryInput.buffer;
                                totalFileSize = retryInput.totalFileSize || buffer.byteLength;
                                totalFileSizeKnown = retryInput.totalFileSizeKnown !== false;
                                rangeRepresentationComplete = retryInput.inputComplete !== false;
                                metadata = extractMetadata(buffer, {
                                    format: detectedFormat,
                                    inputComplete: rangeRepresentationComplete,
                                });
                            } else {
                                const retryFailure = new Error(`HTTP ${retryResponse.status}`);
                                logRangeRequestFailure({
                                    phase: 'retry',
                                    domain,
                                    url: activeUrl,
                                    status: retryResponse.status,
                                    error: retryFailure
                                });
                                debugLog('[AI Meta Viewer] ⚠ Retry Range failed; using full fetch fallback if available.', {
                                    domain: domain || '(unknown)',
                                    status: retryResponse.status
                                });
                                throw retryFailure;
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
                        if (fullFetchFallbackAttempted) throw retryError;
                        await fetchFullAndParse();
                    }
                } // if (metadata.isIncomplete) の終わり
            }
        } catch (e) {
            debugLog('[AI Meta Viewer] Parse failed, trying safe full fetch fallback:', e.message);
            if (isRangeRequest && !fullFetchFallbackAttempted) {
                await fetchFullAndParse();
            } else {
                throw e;
            }
        }

        const metadataState = getMetadataState(metadata);
        const analysisOutcome = metadataState === 'resolved'
            ? 'resolved'
            : metadataState === 'empty-confirmed' || metadataState === 'unsupported-format'
                ? 'confirmed-empty'
                : metadataState === 'resource-limit'
                    ? 'resource-limit'
                    : metadataState === 'unresolved' ? 'unresolved' : 'failure';
        debugLog({ category: 'parser', phase: 'background', event: 'parse-result', analysisOutcome, urlId });
        if (metadataState === 'invalid') {
            const parserReason = metadata.parserReason || 'invalid-metadata';
            if (isFileScheme) {
                const error = new Error('Metadata parser reported structurally invalid input.');
                error.name = 'MetadataInvalidError';
                error.format = detectedFormat;
                error.parserState = metadataState;
                error.parserReason = parserReason;
                return createFileFailureResult(error, {
                    format: detectedFormat,
                    parserState: metadataState,
                    parserReason,
                    reason: parserReason,
                });
            }
            return {
                success: false,
                analysisState: 'failure',
                parserState: metadataState,
                parserReason,
                error: 'Metadata parser reported structurally invalid input.',
            };
        }
        if (isFileScheme) {
            filePhase = 'parser';
            fileFormat = detectedFormat;
            const parserReason = metadata.parserReason;
            if (metadataState === 'resource-limit') {
                const error = new Error('Metadata parsing exceeded the resource limit.');
                error.name = 'MetadataResourceLimitError';
                error.format = detectedFormat;
                error.parserState = metadataState;
                error.parserReason = parserReason || 'resource-limit';
                error.reason = 'resource-limit';
                return createFileFailureResult(error, {
                    format: detectedFormat,
                    parserState: metadataState,
                    parserReason: parserReason || 'resource-limit',
                    reason: 'resource-limit',
                });
            }
            if (metadataState === 'unresolved') {
                const error = new Error('Metadata parsing did not produce a complete representation.');
                error.name = 'MetadataUnresolvedError';
                error.format = detectedFormat;
                error.parserState = metadataState;
                error.parserReason = parserReason || 'metadata-unresolved';
                error.reason = 'metadata-unresolved';
                return createFileFailureResult(error, {
                    format: detectedFormat,
                    parserState: metadataState,
                    parserReason: parserReason || 'metadata-unresolved',
                    reason: 'metadata-unresolved',
                    analysisState: 'unresolved',
                });
            }
            if (metadataState === 'empty-confirmed' || metadataState === 'unsupported-format') {
                await metadataCache.set(imageUrl, {}, {
                    parserVersion: PARSER_CACHE_VERSION,
                    parserState: metadataState,
                });
                return createFileResult({
                    state: metadataState,
                    format: detectedFormat,
                    parserState: metadataState,
                    parserReason,
                    reason: parserReason || 'unsupported-format',
                });
            }
            if (metadataState === 'resolved') {
                if (metadata.metadataPartial !== true) {
                    await metadataCache.set(imageUrl, metadata, {
                        parserVersion: PARSER_CACHE_VERSION,
                    });
                }
                return createFileResult({
                    state: 'resolved',
                    format: detectedFormat,
                    metadata,
                    parserState: metadataState,
                    parserReason,
                    metadataPartial: metadata.metadataPartial === true,
                    reason: 'found',
                });
            }
            return createFileFailureResult(new Error('Metadata parser failed.'), {
                format: detectedFormat,
                parserState: metadataState,
                reason: 'parser-failure',
            });
        }
        if (metadataState === 'resource-limit') {
            const error = new Error('Metadata parsing exceeded the resource limit.');
            error.name = 'MetadataResourceLimitError';
            error.diagnostics = [{
                category: 'resource-limit',
                phase: 'parser',
                reason: metadata.parserReason || 'resource-limit',
            }];
            throw error;
        }
        if (metadataState === 'unresolved') {
            throw new Error('Metadata parsing did not produce a complete representation.');
        }
        if (metadataState === 'empty-confirmed' || metadataState === 'unsupported-format') {
            await metadataCache.set(imageUrl, {}, {
                parserVersion: PARSER_CACHE_VERSION,
                parserState: metadataState,
            });
        } else if (Object.keys(metadata).length > 0) {
            if (metadata.metadataPartial !== true) {
                await metadataCache.set(imageUrl, metadata, {
                    parserVersion: PARSER_CACHE_VERSION,
                });
            }
        }
        return {
            success: true,
            metadata,
            ...(metadata.metadataPartial === true ? { metadataPartial: true } : {}),
        };

    } catch (error) {
        const status = Number.isInteger(error?.status) ? error.status : undefined;
        debugLog({
            category: 'acquisition',
            phase: 'background',
            event: 'request-failure',
            errorType: status ? 'invalid-response' : inferSafeErrorType(error?.name || error?.message),
            status,
            urlId,
        });
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

