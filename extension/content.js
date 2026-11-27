// content.js - Universal Content Script (Chrome & Firefox)

// ブラウザAPI統一
const browserAPI = (() => {
    if (typeof browser !== 'undefined') {
        return browser; // Firefox
    } else if (typeof chrome !== 'undefined') {
        // Chrome - 必要に応じてPromise化
        return {
            ...chrome,
            runtime: {
                ...chrome.runtime,
                sendMessage: (message) => new Promise((resolve, reject) => {
                    chrome.runtime.sendMessage(message, (response) => {
                        if (chrome.runtime.lastError) {
                            reject(new Error(chrome.runtime.lastError.message));
                        } else {
                            resolve(response);
                        }
                    });
                })
            }
        };
    }
    throw new Error('No browser API available');
})();

// 環境検出
const isFirefox = typeof browser !== 'undefined';
const isChrome = typeof chrome !== 'undefined' && !isFirefox;

debugLog(`[AI Meta Viewer] Content script loaded (${isFirefox ? 'Firefox' : 'Chrome'}):`, window.location.href);

// file:// URL では console.log が表示されないことがあるため、DOM に表示するデバッグ機能を追加
let debugLogContainer = null;
const MAX_DEBUG_LOGS = 20; // 最大保持ログ数
let contentSettingsReady = false;

// 遅延 A（ui.js + ui.css）は Service Worker に注入を要求する。
// 応答が success になるまで loaded にしないため、失敗時は次の操作で再試行できる。
const lazyUiModule = createLazyModuleClient({
    moduleName: 'ui',
    sendMessage: (message) => sendMessageToBrave(message),
    isReady: () => window.__aiMetaViewerUiModuleReady === true,
});

function ensureLazyUiModule() {
    return lazyUiModule.ensure().catch((error) => {
        debugLog({
            category: 'message',
            phase: 'content',
            errorType: 'import',
            retryable: true,
        });
        throw error;
    });
}

const CONTENT_SAFE_ENUMS = Object.freeze({
    category: Object.freeze([
        'acquisition', 'file-access', 'representation-mismatch', 'resource-limit',
        'scanner-failure', 'cancelled', 'parser', 'scanner', 'message', 'cache',
        'storage', 'settings', 'fatal-initialization',
    ]),
    phase: Object.freeze(['background', 'content', 'settings', 'initialization', 'download', 'acquisition', 'scanner']),
    errorType: Object.freeze(['timeout', 'abort', 'network', 'invalid-response', 'storage', 'import', 'unknown']),
    scannerStatus: Object.freeze([
        'detected', 'empty', 'failed', 'skipped', 'complete', 'not-found',
        'invalid-png', 'resource-limit', 'scanner-failure', 'cancelled', 'unknown',
    ]),
    event: Object.freeze([
        'check-skipped', 'analysis-skip', 'analysis-start', 'stale-result', 'cache-hit', 'cache-miss', 'request-start',
        'response', 'analysis-complete', 'badge-show', 'cancel', 'queue-skip',
        'queue-enqueue', 'queue-cancel-pending', 'queue-finish', 'dom-remove', 'src-mutation',
        'source-selection-change',
    ]),
    cacheState: Object.freeze(['hit-positive', 'hit-empty', 'hit-legacy-empty', 'miss']),
    analysisOutcome: Object.freeze(['resolved', 'confirmed-empty', 'unresolved', 'failure', 'cancelled', 'source-changed']),
    reason: Object.freeze([
        'processed-marker', 'viewport-exit', 'dom-removed', 'src-change', 'source-selection',
        'request-active', 'request-inactive', 'already-running', 'already-pending', 'queue-overflow',
        'context-invalid', 'no-src', 'site-excluded', 'too-small',
    ]),
    scheme: Object.freeze(['file', 'http', 'https'])
});

const sharedDiagnostics = window.SafeDiagnostics;

const TRANSIENT_EXTENSION_CONTEXT_ERROR_CODE = 'transient-extension-context';
const TRANSIENT_EXTENSION_CONTEXT_ERROR_PATTERNS = Object.freeze([
    'extension context invalidated',
    'extension context is invalid',
    'receiving end does not exist',
    'could not establish connection',
    'the message port closed before a response was received',
    'the message channel closed before a response was received',
]);

function getExtensionMessageErrorText(error) {
    if (typeof error === 'string') return error;
    try {
        return error && typeof error.message === 'string' ? error.message : '';
    } catch (_) {
        return '';
    }
}

function isTransientExtensionContextError(error) {
    if (error && error.code === TRANSIENT_EXTENSION_CONTEXT_ERROR_CODE) return true;
    const message = getExtensionMessageErrorText(error).toLowerCase();
    return message.length > 0 && TRANSIENT_EXTENSION_CONTEXT_ERROR_PATTERNS.some(pattern => message.includes(pattern));
}

function createTransientExtensionContextError() {
    const error = new Error('Extension context invalidated');
    error.name = 'TransientExtensionContextError';
    error.code = TRANSIENT_EXTENSION_CONTEXT_ERROR_CODE;
    return error;
}

function setSafeContentField(diagnostic, key, value) {
    if (Object.prototype.hasOwnProperty.call(CONTENT_SAFE_ENUMS, key) && CONTENT_SAFE_ENUMS[key].includes(value)) {
        diagnostic[key] = value;
    } else if (key === 'status' && Number.isInteger(value) && value >= 100 && value <= 599) {
        diagnostic.status = value;
    } else if (key === 'urlId' && typeof value === 'string' && /^[a-f0-9]{16}$/.test(value)) {
        diagnostic.urlId = value;
    } else if (['imageId', 'runId', 'candidateIndex', 'imageIndex', 'width', 'height'].includes(key) &&
        Number.isSafeInteger(value) && value >= 0) {
        diagnostic[key] = value;
    } else if (['bodyPresent', 'retryable', 'processed', 'activeRequest', 'sameSrc', 'running', 'cancelled'].includes(key) &&
        typeof value === 'boolean') {
        diagnostic[key] = value;
    }
}

function toSafeContentDiagnostic(args) {
    const diagnostic = { redacted: false };
    for (const value of args) {
        if (typeof value === 'string') {
            sharedDiagnostics.classifyString(value, diagnostic);
        } else if (typeof value === 'number') {
            setSafeContentField(diagnostic, 'status', value);
        } else if (value && (typeof value === 'object' || typeof value === 'function')) {
            let errorLike = false;
            try {
                errorLike = value instanceof Error ||
                    (typeof value.name === 'string' && (typeof value.message === 'string' || typeof value.stack === 'string'));
            } catch (_) {
                diagnostic.redacted = true;
            }
            if (errorLike) {
                const errorName = sharedDiagnostics.readOwnProperty(value, 'name');
                const normalizedName = typeof errorName === 'string' ? errorName.toLowerCase() : '';
                diagnostic.errorType = normalizedName.includes('abort') ? 'abort' :
                    normalizedName.includes('timeout') ? 'timeout' :
                        normalizedName.includes('network') ? 'network' : 'unknown';
            } else if (typeof URL !== 'undefined' && value instanceof URL) {
                const protocol = value.protocol.toLowerCase();
                if (protocol === 'file:') diagnostic.scheme = 'file';
                else if (protocol === 'http:') diagnostic.scheme = 'http';
                else if (protocol === 'https:') diagnostic.scheme = 'https';
            } else {
                for (const key of [
                    'category', 'phase', 'errorType', 'status', 'bodyPresent', 'scannerStatus', 'retryable', 'scheme',
                    'event', 'cacheState', 'analysisOutcome', 'reason', 'urlId', 'imageId', 'runId',
                    'candidateIndex', 'imageIndex', 'width', 'height', 'processed', 'activeRequest', 'sameSrc', 'running', 'cancelled',
                ]) {
                    setSafeContentField(diagnostic, key, sharedDiagnostics.readOwnProperty(value, key));
                }
            }
            diagnostic.redacted = true;
        } else if (value !== null && value !== undefined) {
            diagnostic.redacted = true;
        }
    }
    if (!diagnostic.errorType) diagnostic.errorType = 'unknown';
    return diagnostic;
}

function formatSafeContentDiagnostic(diagnostic) {
    return sharedDiagnostics.formatSafeDiagnostic(diagnostic, {
        orderedKeys: [
            'category', 'phase', 'event', 'imageId', 'runId', 'imageIndex', 'candidateIndex', 'urlId',
            'cacheState', 'analysisOutcome', 'reason', 'activeRequest', 'processed', 'running', 'sameSrc',
            'width', 'height', 'cancelled', 'errorType', 'status', 'bodyPresent', 'scannerStatus', 'retryable', 'scheme',
        ],
        trusted: true,
        maxLength: 240,
    });
}

// settings_loader.js で定義された window.debugLog を拡張
const baseDebugLog = window.debugLog;
window.debugLog = function (...args) {
    const safeDiagnostic = toSafeContentDiagnostic(args);
    const safeText = formatSafeContentDiagnostic(safeDiagnostic);

    // 基本のコンソール出力には安全化済みの値だけを渡す
    if (typeof baseDebugLog === 'function') {
        baseDebugLog(safeDiagnostic);
    } else if (contentSettingsReady && window.settings && window.settings.debugMode === true) {
        console.log(safeText);
    }

    // debugMode が厳密な true で、設定読込完了後かつ file:// URL の場合のみ DOM に表示
    if (!contentSettingsReady || !window.settings || window.settings.debugMode !== true || window.location.protocol !== 'file:') {
        return;
    }

    // コンテナがまだない場合は作成
    if (!debugLogContainer && document.body) {
        debugLogContainer = document.createElement('div');
        debugLogContainer.id = 'ai-meta-viewer-debug-log';
        debugLogContainer.style.cssText = 'position:fixed;bottom:0;left:0;right:0;max-height:200px;overflow-y:auto;background:rgba(0,0,0,0.9);color:#0f0;padding:5px;z-index:999999;font-size:11px;font-family:monospace;border-top:2px solid #0f0;';
        document.body.appendChild(debugLogContainer);
    }

    if (debugLogContainer) {
        const logEntry = document.createElement('div');
        logEntry.style.cssText = 'padding:2px 0;border-bottom:1px solid rgba(0,255,0,0.2);';
        const timestamp = new Date().toLocaleTimeString('ja-JP', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
        logEntry.textContent = `[${timestamp}] ${safeText}`;
        debugLogContainer.appendChild(logEntry);

        // 最大数を超えたら古いログを削除
        while (debugLogContainer.children.length > MAX_DEBUG_LOGS) {
            debugLogContainer.removeChild(debugLogContainer.firstChild);
        }

        // 最新ログまでスクロール
        debugLogContainer.scrollTop = debugLogContainer.scrollHeight;
    }
};

// 設定、除外判定、初期化ロジックは settings_loader.js に移動しました。

// Braveブラウザ対応：拡張機能の状態監視
let extensionHealthCheck = null;
let healthCheckFailureCount = 0;

function startExtensionHealthCheck() {
    // 既にヘルスチェックが動作している場合はスキップ
    if (extensionHealthCheck) return;

    extensionHealthCheck = setInterval(() => {
        // 拡張機能のコンテキストが有効かチェック（軽量版）
        if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
            healthCheckFailureCount++;

            // 3回連続で失敗した場合のみ警告を出す
            if (healthCheckFailureCount >= 3) {
                debugLog({ category: 'message', phase: 'content', errorType: 'unknown', retryable: true });

                // 必要に応じて再初期化を試行
                clearInterval(extensionHealthCheck);
                extensionHealthCheck = null;
                extensionInitialized = false;
                healthCheckFailureCount = 0;

                // 少し待ってから再初期化を試行
                setTimeout(() => {
                    if (chrome && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
                        debugLog('[AI Meta Viewer] Extension context recovered, reinitializing...');
                        init();
                        startExtensionHealthCheck();
                    }
                }, 2000);
            }
        } else {
            // 正常な場合はカウンターをリセット
            healthCheckFailureCount = 0;
        }
    }, 60000); // 60秒ごとにチェック（頻度を下げる）
}

// 初期化時に設定を読み込む (settings_loader.js で定義された loadSettings を使用)
loadSettings().then(() => {
    contentSettingsReady = true;
    debugLog('[AI Meta Viewer] Settings loaded:', settings);

    // 除外サイトチェック
    if (isExcludedUrl()) {
        debugLog('[AI Meta Viewer] Site excluded by settings:', window.location.href);
        return;
    }

    debugLog('[AI Meta Viewer] Initializing extension on:', window.location.href);

    // 初期化実行
    if (document.readyState === 'loading') {
        debugLog('[AI Meta Viewer] Document still loading, waiting for DOMContentLoaded');
        document.addEventListener('DOMContentLoaded', () => {
            init();
            startExtensionHealthCheck();
        });
    } else {
        debugLog('[AI Meta Viewer] Document ready, calling init()');
        init();
        startExtensionHealthCheck();
    }
});

// 拡張機能の再初期化フラグ
let extensionInitialized = false;

function init() {
    debugLog('[AI Meta Viewer] init() called');

    // 既に初期化済みの場合はスキップ
    if (extensionInitialized) {
        debugLog('[AI Meta Viewer] Already initialized, skipping');
        return;
    }

    if (isDirectImageView()) {
        debugLog('[AI Meta Viewer] Direct image view detected');
        ensureLazyUiModule().then(() => {
            if (typeof handleDirectImageView === 'function') handleDirectImageView();
            else {
                const img = document.querySelector('img');
                if (img) checkImageMetadata(img);
            }
        }).catch(() => {
            const img = document.querySelector('img');
            if (img) checkImageMetadata(img);
        });
    } else {
        debugLog('[AI Meta Viewer] Normal page view, starting image observation');
        observeImages();
        observeSiteSpecificElements();
    }
    startLazyVideoObservation();
    startSpaUrlTracking();

    extensionInitialized = true;
}

// 処理済み画像とバッジデータの管理、ResizeObserverなどは badge_controller.js に移動しました


// 画像URLごとのメタデータキャッシュ（content script内のメモリキャッシュ）
// 注意: scanner/core.js に同名の localMetadataCache が存在するため、
// content.js 側は contentMetadataCache として区別する
const contentMetadataCache = new Map();
const imageSourceRechecks = new WeakSet();
const imageAnalyzingBadgeStates = new WeakMap();
// 処理済みマーカーがどのcurrentSrcに対するものか記録する。
const imageAnalyzedSources = new WeakMap();
const videoAnalyzedSources = new Map();
const videoSelectedSources = new Map();
const activeVideoAnalysisStates = new WeakMap();
const observedVideoElements = new WeakSet();
const pendingVideoAnalyses = new Map();
const runningVideoAnalyses = new Set();
const VIDEO_ANALYSIS_MAX_CONCURRENT = 4;
let videoMetadataIntersectionObserver = null;
let videoMetadataMutationObserver = null;
let videoMediaEventsRegistered = false;
let sourceSelectionListenersRegistered = false;
const ANALYZING_BADGE_DELAY_MS = 200;
const imageDiagnosticIds = new WeakMap();
const imageAnalysisRunIds = new WeakMap();
let nextImageDiagnosticId = 0;
let nextImageAnalysisRunId = 0;

function clearImageAnalyzingBadge(img, expectedRunId = null) {
    const state = imageAnalyzingBadgeStates.get(img);
    if (!state || (expectedRunId !== null && state.runId !== expectedRunId)) return;
    if (state.timer !== null) clearTimeout(state.timer);
    if (state.badge) removeAnalyzingBadge(state.badge);
    imageAnalyzingBadgeStates.delete(img);
}

function getCurrentImageSource(img) {
    return img.currentSrc || img.src;
}

function getImageDiagnosticId(img) {
    if (!imageDiagnosticIds.has(img)) {
        nextImageDiagnosticId += 1;
        imageDiagnosticIds.set(img, nextImageDiagnosticId);
    }
    return imageDiagnosticIds.get(img);
}

function beginImageAnalysisRun(img) {
    nextImageAnalysisRunId += 1;
    imageAnalysisRunIds.set(img, nextImageAnalysisRunId);
    return nextImageAnalysisRunId;
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

function logImageDiagnostic(event, img, details = {}) {
    if (window.settings?.debugMode !== true || !img) return;
    const imageIndex = Array.prototype.indexOf.call(document.images, img);
    const diagnostic = {
        category: 'scanner',
        phase: 'content',
        event,
        imageId: getImageDiagnosticId(img),
        ...(imageAnalysisRunIds.has(img) ? { runId: imageAnalysisRunIds.get(img) } : {}),
        ...(imageIndex >= 0 ? { imageIndex } : {}),
        urlId: getSafeUrlId(img.currentSrc || img.src),
        ...(Number.isSafeInteger(img.naturalWidth) ? { width: img.naturalWidth } : {}),
        ...(Number.isSafeInteger(img.naturalHeight) ? { height: img.naturalHeight } : {}),
        ...details,
    };
    debugLog(diagnostic);

    // Service Worker の DevTools から content script の画像処理も追えるようにする。
    // background 側でも allowlist による再検査を行い、URLや任意文字列は転送しない。
    try {
        const pendingMessage = browserAPI.runtime.sendMessage({
            action: 'contentDiagnostic',
            diagnostic,
        });
        if (pendingMessage && typeof pendingMessage.catch === 'function') {
            pendingMessage.catch(() => {});
        }
    } catch (_) {
        // 診断ログの転送失敗は画像解析に影響させない。
    }
}

// --- サイト別アダプター (互換性のためグローバルな SiteAdapters を使用) ---
// adapters.js に分離されました。

/**
 * 解析中URLの登録簿。取り消し時に background へ通知するために使う。
 * @type {WeakMap<HTMLImageElement, string>}
 */
const activeAnalysisUrls = new WeakMap();
const activeImageRequests = new WeakSet();

/**
 * 取り消し済み画像。URL候補の順次試行を打ち切るために使う。
 * @type {WeakSet<HTMLImageElement>}
 */
const cancelledAnalyses = new WeakSet();

/**
 * cancel通知を同一解析につき一度だけ送るための状態。
 * @type {WeakSet<HTMLImageElement>}
 */
const cancelNotificationsSent = new WeakSet();

/**
 * 実行中の解析を background へ取り消し通知する
 * @param {HTMLImageElement} img - 対象画像
 */
function cancelActiveAnalysis(img, reason = 'viewport-exit') {
    const url = activeAnalysisUrls.get(img);
    const activeRequest = activeImageRequests.has(img);
    logImageDiagnostic('cancel', img, {
        reason,
        activeRequest,
        processed: processedImages.has(img),
        ...(url ? { urlId: getSafeUrlId(url) } : {}),
    });
    // viewport退出時に応答待ちでない処理まで無効化すると、完了結果を捨てて再解析を招く。
    // 実リクエストがない場合は状態を変えず、DOM削除時の後始末は呼び出し元に任せる。
    if (!activeRequest || !url) return;
    cancelledAnalyses.add(img);
    // 取り消し直後から再度viewport判定を受けられるようmarkerを除去する。
    processedImages.delete(img);
    imageAnalyzedSources.delete(img);
    if (!url || cancelNotificationsSent.has(img)) return;
    cancelNotificationsSent.add(img);
    debugLog('[AI Meta Viewer] Cancelling in-flight analysis:', url.substring(0, 80));
    sendMessageToBrave({ action: 'cancelImageMetadata', imageUrl: url }).catch(() => {
        // 取り消し通知の失敗は解析結果に影響しない
    });
}

/**
 * 解析の取り消し状態を解除する
 * @param {HTMLImageElement} img - 対象画像
 */
function clearActiveAnalysis(img) {
    activeAnalysisUrls.delete(img);
    cancelledAnalyses.delete(img);
    cancelNotificationsSent.delete(img);
}

/**
 * 画像のメタデータを確認する
 * @param {HTMLImageElement} img - 対象画像要素
 * @param {Object} [requestOptions] - 解析要求のオプション
 * @param {string} [requestOptions.action] - background へ送る action。優先度を表す
 */
async function checkImageMetadata(img, requestOptions = {}) {
    const fetchAction = requestOptions.action || 'fetchImageMetadata';
    const getImageSource = () => getCurrentImageSource(img);
    debugLog('[AI Meta Viewer] checkImageMetadata() called for:', getImageSource());

    // 拡張機能のコンテキストが無効化されている場合は処理を停止
    if (!isExtensionContextValid()) {
        logImageDiagnostic('analysis-skip', img, { reason: 'context-invalid' });
        debugLog({ category: 'message', phase: 'content', errorType: 'unknown', retryable: false });
        return;
    }

    if (isVideoLinkedThumbnail(img)) {
        // 動画リンクのサムネイルは動画URL側を解析し、画像bytesとの二重表示を避ける。
        if (processedImages.get(img)?.badge?._mediaType === 'image') removeBadge(img);
        processedImages.delete(img);
        return;
    }

    // 新しい解析要求では、過去のcancel markerを再利用しない。
    cancelledAnalyses.delete(img);

    // 重複チェック
    if (processedImages.has(img)) {
        logImageDiagnostic('check-skipped', img, { reason: 'processed-marker', processed: true });
        debugLog(`[AI Meta Viewer] Image already processed, skipping: ${getImageSource().substring(0, 60)}...`);
        return;
    }

    debugLog(`[AI Meta Viewer] checkImageMetadata called for: ${getImageSource().substring(0, 60)}...`);

    const src = getImageSource();
    const debugAllDetections = settings.debugAllDetections === true || settings.debugForceFullFetch === true;
    if (!src) {
        logImageDiagnostic('analysis-skip', img, { reason: 'no-src' });
        debugLog('[AI Meta Viewer] No src, skipping');
        return;
    }
    const srcAttributeAtStart = img.getAttribute('src');
    const srcsetAttributeAtStart = img.getAttribute('srcset');
    const hasSourceChanged = () => getImageSource() !== src ||
        img.getAttribute('src') !== srcAttributeAtStart ||
        img.getAttribute('srcset') !== srcsetAttributeAtStart;

    // ターゲットURLの解決
    let targetUrl = src;
    let isLinkedImage = false;

    // アダプターを使ってオリジナル画像を探索（対象ホストでのみ adapters.js が読み込まれる）
    if (Array.isArray(window.SiteAdapters)) {
        for (const adapter of SiteAdapters) {
            if (adapter.match()) {
                if (adapter.isAnalysisExcluded?.(img)) {
                    logImageDiagnostic('analysis-skip', img, { reason: 'site-excluded' });
                    debugLog('[AI Meta Viewer] Image is excluded by site adapter:', src.substring(0, 80));
                    return;
                }
                const resolvedUrl = adapter.resolve(img);
                if (resolvedUrl) {
                    targetUrl = resolvedUrl;
                    isLinkedImage = true;
                    debugLog('[AI Meta Viewer] Adapter resolved URL:', {
                        originalSrc: src.substring(0, 80),
                        resolvedUrl: Array.isArray(resolvedUrl) ? resolvedUrl.map(u => u.substring(0, 80)) : resolvedUrl.substring(0, 80)
                    });
                    break; // 最初に見つかったものを採用
                }
            }
        }
    }

    // 汎用アダプター（全サイト共通）は常駐側のフォールバックとして維持する。
    if (!isLinkedImage) {
        const parentLink = img.closest('a');
        const href = parentLink?.href;
        if (href && /\.(png|jpg|jpeg|webp|avif|gif)$/i.test(href.split('?')[0])) {
            targetUrl = href;
            isLinkedImage = true;
        }
    }

    if (!isLinkedImage) {
        debugLog('[AI Meta Viewer] No adapter resolved URL for:', src.substring(0, 80));
    }

    // サイズチェック
    const actualWidth = img.naturalWidth || img.width;
    const actualHeight = img.naturalHeight || img.height;
    const pixelCount = actualWidth * actualHeight;

    // Pixiv判定
    const isPixiv = window.location.hostname.includes('pixiv.net');
    const isDiscord = window.location.hostname.includes('discord.com');

    // サイズによる除外判定
    let isTooSmall = false;

    // リンク画像でない場合（直接表示など）は、設定された最小画素数でチェック
    if (!debugAllDetections && !isLinkedImage && pixelCount < settings.minPixelCount) {
        isTooSmall = true;
    }

    // リンク画像の場合でも、設定された最小サイズ未満は除外（デフォルト200x200）
    if (!debugAllDetections && isLinkedImage && (actualWidth < settings.minImageSize || actualHeight < settings.minImageSize)) {
        isTooSmall = true;
    }

    // PixivやDiscordの場合は、サムネイルが小さくてもオリジナル画像にメタデータがある可能性が高いため、
    // アダプターで解決できた（isLinkedImage === true）場合のみサイズ制限を無視する
    if (isLinkedImage && (isPixiv || isDiscord)) {
        isTooSmall = false;
    }

    // [Discord専用: ユーザーアイコン対策]
    // リンク解決の有無に関わらず、表示サイズが極端に小さいものやAvatar画像は除外する
    if (!debugAllDetections && isDiscord) {
        const displayWidth = img.width || img.clientWidth || actualWidth;
        const displayHeight = img.height || img.clientHeight || actualHeight;

        // 表示サイズが80x80以下のもの、またはURLがアバターのものは強制的に除外
        if ((displayWidth <= 80 && displayHeight <= 80) || (src && src.includes('/avatars/'))) {
            isTooSmall = true;
        }
    }

    if (!debugAllDetections && isTooSmall) {
        logImageDiagnostic('analysis-skip', img, { reason: 'too-small' });
        debugLog('[AI Meta Viewer] Image too small, skipping:', {
            src: src.substring(0, 80),
            actualWidth,
            actualHeight,
            pixelCount,
            isLinkedImage
        });
        // 処理済みフラグを削除（画像読み込み後にサイズが確定してから再試行させるため）
        processedImages.delete(img);
        imageAnalyzedSources.delete(img);
        return;
    }

    // 処理済みフラグを立てる（重複チェック防止）
    // 注意: 処理中であることを示すマーカーを設定
    // 実際のバッジデータは addBadgeToImage() で設定される
    imageAnalyzedSources.delete(img);
    processedImages.set(img, null);
    const runId = beginImageAnalysisRun(img);
    logImageDiagnostic('analysis-start', img, { runId, processed: true });

    // Pixivまたはローカルファイル、または全サイト設定が有効な場合、解析中バッジを表示
    const isLocalFile = targetUrl && (Array.isArray(targetUrl) ? targetUrl[0] : targetUrl).startsWith('file://');

    let shouldShowBadge = isPixiv || isLocalFile;
    if (settings.analyzeEverywhere) {
        shouldShowBadge = true;
    }

    const analyzingBadgeState = { runId, badge: null, timer: null };
    const scheduleAnalyzingBadge = () => {
        if (analyzingBadgeState.badge || analyzingBadgeState.timer !== null || !shouldShowBadge || !settings.showAnalyzingBadge) return;
        imageAnalyzingBadgeStates.set(img, analyzingBadgeState);
        analyzingBadgeState.timer = setTimeout(() => {
            analyzingBadgeState.timer = null;
            if (cancelledAnalyses.has(img) || imageAnalysisRunIds.get(img) !== runId || hasSourceChanged()) return;
            logImageDiagnostic('badge-show', img);
            analyzingBadgeState.badge = addAnalyzingBadge(img);
        }, ANALYZING_BADGE_DELAY_MS);
    };

    let analysisOutcome = null;
    let metadata = null;
    let successUrl = null;
    let failureResponse = null;
    const classifyResponse = (response) => {
        const explicitState = response?.analysisState;
        if (['resolved', 'confirmed-empty', 'unresolved', 'failure'].includes(explicitState)) {
            if (explicitState === 'resolved') {
                const hasMetadata = response?.success === true && response.metadata &&
                    typeof response.metadata === 'object' && Object.keys(response.metadata).length > 0;
                if (response?.metadataPartial === true || response?.metadata?.metadataPartial === true) {
                    return 'unresolved';
                }
                return hasMetadata ? 'resolved' : 'failure';
            }
            if (explicitState === 'confirmed-empty') {
                const hasUnexpectedMetadata = response?.metadata &&
                    typeof response.metadata === 'object' && Object.keys(response.metadata).length > 0;
                return response?.success === true && !hasUnexpectedMetadata
                    ? 'confirmed-empty'
                    : 'failure';
            }
            return response?.success === false ? explicitState : 'failure';
        }
        // analysisState をまだ返さない既存 HTTP 応答との後方互換分類。
        if (response?.success === true && response.metadata && typeof response.metadata === 'object') {
            if (response.metadataPartial === true || response.metadata.metadataPartial === true) return 'unresolved';
            return Object.keys(response.metadata).length > 0 ? 'resolved' : 'confirmed-empty';
        }
        return 'failure';
    };

    try {
        // targetUrl が配列の場合（Pixivのサムネイルなど）、順次試行
        const urlsToTry = Array.isArray(targetUrl) ? targetUrl : [targetUrl];

        for (const [candidateIndex, url] of urlsToTry.entries()) {
            // 画面外へ出て取り消された場合は残りの候補を試行しない
            if (cancelledAnalyses.has(img)) {
                debugLog('[AI Meta Viewer] Analysis cancelled, stopping candidate loop:', url.substring(0, 80));
                analysisOutcome = 'cancelled';
                failureResponse = { success: false, diagnostics: { category: 'cancelled', phase: 'content' } };
                break;
            }

            // キャッシュチェック
            if (!debugAllDetections && contentMetadataCache.has(url)) {
                const cachedMetadata = contentMetadataCache.get(url);
                logImageDiagnostic('cache-hit', img, {
                    candidateIndex,
                    urlId: getSafeUrlId(url),
                    cacheState: cachedMetadata && Object.keys(cachedMetadata).length > 0
                        ? 'hit-positive'
                        : 'hit-empty',
                });
                if (cachedMetadata && Object.keys(cachedMetadata).length > 0) {
                    metadata = cachedMetadata;
                    successUrl = url;
                    analysisOutcome = 'resolved';
                    break;
                }
                continue;
            }
            logImageDiagnostic('cache-miss', img, {
                candidateIndex,
                urlId: getSafeUrlId(url),
                cacheState: 'miss',
            });

            // メッセージペイロードの準備
            // 優先度は action で表現し、fetchImageMetadata の契約へ項目を追加しない
            const message = {
                action: fetchAction,
                imageUrl: url
            };

            // ローカルファイル (file://) の場合
            // content.js からの fetch/XHR はセキュリティ制限で失敗するため、
            // background.js に直接任せる (Chromeの設定で許可されている場合のみ成功する)
            if (url.startsWith('file://')) {
                debugLog('[AI Meta Viewer] Local file detected, delegating fetch to background script:', url);
            }

            // Background Service Workerにメタデータ取得をリクエスト
            try {
                // 取り消し通知で対象URLを特定できるよう登録しておく
                activeAnalysisUrls.set(img, url);
                activeImageRequests.add(img);
                // background の永続キャッシュヒットで短時間に返る場合は、Analyzingを表示しない。
                scheduleAnalyzingBadge();
                logImageDiagnostic('request-start', img, {
                    candidateIndex,
                    urlId: getSafeUrlId(url),
                    activeRequest: true,
                });
                const response = await sendMessageToBrave(message);
                activeImageRequests.delete(img);

                const responseState = classifyResponse(response);
                logImageDiagnostic('response', img, {
                    candidateIndex,
                    urlId: getSafeUrlId(url),
                    analysisOutcome: responseState,
                    activeRequest: false,
                });
                if (responseState === 'resolved') {
                    metadata = response.metadata;
                    if (debugAllDetections && response.debug && metadata && typeof metadata === 'object' &&
                        metadata.__debugDetection === undefined) {
                        metadata.__debugDetection = response.debug;
                    }
                    if (!debugAllDetections) contentMetadataCache.set(url, metadata);
                    successUrl = url;
                    analysisOutcome = 'resolved';
                    break; // 成功したらループを抜ける
                }
                if (responseState === 'confirmed-empty') {
                    // 完了確認済みの空結果だけを候補の empty として扱う。
                    if (!debugAllDetections) contentMetadataCache.set(url, {});
                    analysisOutcome = 'confirmed-empty';
                    continue;
                }

                // unresolved/failure は empty へ降格させず、候補が残る場合だけ次を試行する。
                failureResponse = response && typeof response === 'object'
                    ? { ...response, success: false, analysisState: responseState }
                    : {
                        success: false,
                        analysisState: responseState,
                        diagnostics: { category: 'response-contract', phase: 'content' }
                    };
            } catch (e) {
                activeImageRequests.delete(img);
                const isTransientMessageFailure = isTransientExtensionContextError(e);
                failureResponse = {
                    success: false,
                    transient: isTransientMessageFailure,
                    diagnostics: {
                        category: 'message',
                        phase: 'content',
                        errorType: 'unknown',
                        ...(isTransientMessageFailure ? { retryable: true } : {})
                    }
                };
                // 拡張機能切断時は候補URLを続けて試行せず、失敗として終了する。
                if (isTransientMessageFailure) break;
            }
        }

        if (cancelledAnalyses.has(img)) {
            analysisOutcome = 'cancelled';
            return;
        }

        // Aの取得結果はURLキャッシュへ残し、再利用要素のBには表示しない。
        // キュー完了後にIntersectionObserverを張り直して、現在のsourceを解析する。
        if (hasSourceChanged()) {
            analysisOutcome = 'source-changed';
            const isCurrentRun = imageAnalysisRunIds.get(img) === runId;
            if (isCurrentRun) {
                processedImages.delete(img);
                clearImageAnalyzingBadge(img, runId);
                removeBadge(img);
                if (viewportAnalysisQueue.running.has(img)) imageSourceRechecks.add(img);
            }
            logImageDiagnostic('stale-result', img, {
                runId,
                reason: 'src-change',
                sameSrc: false,
                processed: processedImages.has(img),
                activeRequest: activeImageRequests.has(img),
            });
            return;
        }

        if (analysisOutcome !== 'resolved' && failureResponse) {
            analysisOutcome = 'failure';
            if (failureResponse.transient !== true) {
                logContentAnalysisFailure(failureResponse);
            }
            return;
        }

        if (analysisOutcome !== 'resolved' && analysisOutcome !== 'confirmed-empty') {
            analysisOutcome = 'confirmed-empty';
        }

        // 取り消し後に到着した応答を結果として確定させない。
        // cancelActiveAnalysis() がmarkerを削除しているため、再表示時に再解析できる。
        if (cancelledAnalyses.has(img)) {
            analysisOutcome = 'cancelled';
            return;
        }

        // --- メタデータフィルタリング (除外判定) ---

        if (analysisOutcome === 'resolved') {
            if (!debugAllDetections) {
                // 1. キーによる除外 (Ignored Metadata Keys)
                if (settings.ignoredMetadataKeys && Array.isArray(settings.ignoredMetadataKeys) && settings.ignoredMetadataKeys.length > 0) {
                    const hasIgnoredKey = Object.keys(metadata).some(key =>
                        settings.ignoredMetadataKeys.includes(key)
                    );

                    if (hasIgnoredKey) {
                        if (settings.debugMode) {
                            debugLog('[AI Meta Viewer] Ignored image due to ignored metadata key');
                        }
                        removeBadge(img); // バッジがあれば削除
                        return;
                    }
                }

                // 2. ソフトウェア名による除外 (Ignored Software)
                if (metadata['Software'] && settings.ignoredSoftware && Array.isArray(settings.ignoredSoftware) && settings.ignoredSoftware.length > 0) {
                    const software = metadata['Software'];
                    const isIgnoredSoftware = settings.ignoredSoftware.some(s => software.includes(s));

                    if (isIgnoredSoftware) {
                        if (settings.debugMode) {
                            debugLog('[AI Meta Viewer] Ignored software:', software);
                        }
                        removeBadge(img); // バッジがあれば削除
                        return;
                    }
                }
            }

            // バッジを追加
            addBadgeToImage(img, metadata, successUrl || src);
        } else {
            // confirmed-emptyだけを通常のメタデータなし経路へ渡す。
            debugLog('[AI Meta Viewer] No metadata found, removing badge if exists:', {
                src: src.substring(0, 80),
                targetUrl: Array.isArray(targetUrl) ? targetUrl.map(u => u.substring(0, 80)) : targetUrl.substring(0, 80),
                urlsToTry: urlsToTry.length
            });
            removeBadge(img);
        }

    } catch (error) {
        analysisOutcome = 'failure';
        logContentAnalysisFailure({
            success: false,
            diagnostics: {
                category: 'content',
                phase: 'content',
                errorType: 'unknown'
            }
        });

        // エラー通知が有効な場合
        if (settings.errorNotification) {
            // 簡易的な通知（実際にはUIに表示する方が良いが、ここではコンソールのみ）
            // 必要に応じてトースト通知などを実装
        }
    } finally {
        clearImageAnalyzingBadge(img, runId);
        if (imageAnalysisRunIds.get(img) === runId) {
            if (analysisOutcome !== 'resolved' && analysisOutcome !== 'confirmed-empty') {
                // failure/unresolved/cancel は成功 marker を残さず再試行可能にする。
                processedImages.delete(img);
                imageAnalyzedSources.delete(img);
            } else if (processedImages.has(img)) {
                imageAnalyzedSources.set(img, src);
            }
            clearActiveAnalysis(img);
        }
        logImageDiagnostic('analysis-complete', img, {
            analysisOutcome: analysisOutcome || 'failure',
            processed: processedImages.has(img),
            activeRequest: activeImageRequests.has(img),
        });
    }
}

/**
 * failure応答から許可された診断項目だけをdebugログへ出力する。
 * 内部error、payload、bytes、署名、ローカルpathは記録しない。
 */
function logContentAnalysisFailure(response) {
    if (typeof window !== 'undefined' && window.settings?.debugMode !== true) return;
    if (response?.transient === true) return;

    const diagnostics = Array.isArray(response?.diagnostics)
        ? response.diagnostics[0]
        : response?.diagnostics;
    const source = diagnostics && typeof diagnostics === 'object' ? diagnostics : response || {};
    const safeDiagnostics = {};
    const allowedKeys = ['category', 'phase', 'status', 'bodyPresent', 'errorType', 'scannerStatus', 'retryable'];
    for (const key of allowedKeys) {
        const value = source[key] ?? response?.[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            safeDiagnostics[key] = value;
        }
    }
    debugLog('[AI Meta Viewer] Metadata analysis failed:', safeDiagnostics);
}


/**
 * サイト別のアダプターからターゲットを取得してメタデータをチェック
 */
function observeSiteSpecificElements() {
    // Civitai の deepScan は adapters.js 側に移した。Civitai 以外では実行しない。
    const isCivitai = window.location.hostname.includes('civitai.com') || document.title.includes('Civitai');
    if (isCivitai && typeof runCivitaiRetryCheck === 'function' && typeof executeDeepScanAndAddBadges === 'function') {
        const startRetry = () => {
            if (typeof resetCivitaiRetryCheck === 'function') resetCivitaiRetryCheck();
            runCivitaiRetryCheck();
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => setTimeout(startRetry, 1000));
        } else {
            setTimeout(startRetry, 1000);
        }
    }

    // アダプターが提供するバッジ対象（Civitai のダウンロードボタン等）は
    // リンク取得に ui.js の checkMetadataForElement を使うため、UI を遅延注入する。
    if (Array.isArray(window.SiteAdapters)) {
        for (const adapter of SiteAdapters) {
            if (adapter.match() && typeof adapter.getBadgeTargets === 'function') {
                const targets = adapter.getBadgeTargets(document);
                if (targets && targets.length > 0) {
                    ensureLazyUiModule().then(() => {
                        if (typeof checkMetadataForElement !== 'function') return;
                        targets.forEach(el => checkMetadataForElement(el));
                    }).catch(() => {});
                }
            }
        }
    }

    startSafetensorsLinkDetection();
}

/**
 * SPA の URL 変化を popstate / hashchange / MutationObserver と
 * 800ms の安全弁で検出する。200ms 周期のポーリングは行わない。
 */
let spaUrlTracker = null;

function handleSpaUrlChange(currentUrl, previousUrl) {
    debugLog('[AI Meta Viewer] SPA URL change detected');
    debugLog('  Old URL:', previousUrl);
    debugLog('  New URL:', currentUrl);

    const beforeMapSize = typeof processedImages !== 'undefined' ? processedImages.size : 0;
    const existingBadges = document.querySelectorAll('.ai-meta-badge, .ai-meta-badge-analyzing');
    existingBadges.forEach(b => {
        try { b.remove(); } catch (e) { debugLog('Error removing badge:', e); }
    });

    if (typeof processedImages !== 'undefined') {
        for (const element of Array.from(processedImages.keys())) removeBadge(element);
        processedImages.clear();
        document.querySelectorAll('img').forEach((img) => {
            viewportAnalysisQueue.observer?.observe(img);
        });
    }
    for (const element of videoSelectedSources.keys()) {
        cancelVideoElement(element);
        videoAnalyzedSources.delete(element);
        if (element.isConnected) {
            videoMetadataIntersectionObserver?.unobserve(element);
            videoMetadataIntersectionObserver?.observe(element);
        }
    }

    debugLog(`[AI Meta Viewer] Cleanup complete. Badges removed: ${existingBadges.length} (Current in DOM: ${document.querySelectorAll('.ai-meta-badge').length}), Map entries cleared: ${beforeMapSize}`);

    setTimeout(() => {
        const isCivitai = window.location.hostname.includes('civitai.com') || document.title.includes('Civitai');
        if (isCivitai && typeof runCivitaiRetryCheck === 'function') {
            if (typeof resetCivitaiRetryCheck === 'function') resetCivitaiRetryCheck();
            runCivitaiRetryCheck();
        }
    }, 800);
}

function startSpaUrlTracking() {
    if (spaUrlTracker) return;
    spaUrlTracker = createSpaUrlTracker({
        getUrl: () => window.location.href,
        onChange: handleSpaUrlChange,
    });
    window.addEventListener('popstate', () => spaUrlTracker.schedule());
    window.addEventListener('hashchange', () => spaUrlTracker.schedule());
    spaUrlTracker.start();
}

/**
 * safetensors リンクの存在だけを常駐側で監視し、実際のリンク解析
 * （checkMetadataForElement / observeGenericSafetensorsLinks）は ui.js に任せる。
 */
let safetensorsLinkDetectionStarted = false;
let safetensorsLinkDetectionActivated = false;
let safetensorsLinkObserver = null;
let safetensorsRetryTimer = null;
let safetensorsRetryAttempts = 0;
const SAFETENSORS_RETRY_LIMIT = 3;
const SAFETENSORS_RETRY_DELAY_MS = 1000;

function scheduleSafetensorsRetry() {
    if (safetensorsRetryTimer !== null || safetensorsRetryAttempts >= SAFETENSORS_RETRY_LIMIT) return;
    safetensorsRetryTimer = setTimeout(() => {
        safetensorsRetryTimer = null;
        safetensorsRetryAttempts += 1;
        activateSafetensorsLinkDetection();
    }, SAFETENSORS_RETRY_DELAY_MS);
}

function activateSafetensorsLinkDetection() {
    if (safetensorsLinkDetectionActivated) return false;
    if (!document.querySelector || !document.querySelector('a[href*=".safetensors"]')) return false;
    safetensorsLinkDetectionActivated = true;
    ensureLazyUiModule().then(() => {
        if (typeof observeGenericSafetensorsLinks !== 'function') {
            safetensorsLinkDetectionActivated = false;
            scheduleSafetensorsRetry();
            return;
        }
        observeGenericSafetensorsLinks();
        safetensorsRetryAttempts = 0;
        if (safetensorsLinkObserver) {
            safetensorsLinkObserver.disconnect();
            safetensorsLinkObserver = null;
        }
    }).catch(() => {
        safetensorsLinkDetectionActivated = false;
        scheduleSafetensorsRetry();
    });
    return true;
}

function startSafetensorsLinkDetection() {
    if (safetensorsLinkDetectionStarted) return;
    safetensorsLinkDetectionStarted = true;
    const observer = new MutationObserver(() => {
        activateSafetensorsLinkDetection();
    });
    safetensorsLinkObserver = observer;
    const root = document.documentElement || document;
    if (root) {
        observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href'],
        });
    }
    activateSafetensorsLinkDetection();
}

/**
 * 拡張機能のコンテキストが有効かどうかをチェック
 * Brave ブラウザ対応版 - より寛容な判定
 */
function isExtensionContextValid() {
    try {
        // 基本的なchrome APIの存在確認
        if (!chrome || !chrome.runtime) {
            return false;
        }

        // sendMessage 関数の存在確認（これが最も重要）
        if (typeof chrome.runtime.sendMessage !== 'function') {
            return false;
        }

        // Braveブラウザでは chrome.runtime.id が undefined になることがあるが、
        // sendMessageが利用可能なら拡張機能は動作していると判定
        // ログ出力は頻繁すぎるので削除
        return true;
    } catch (e) {
        // エラーが発生した場合のみログ出力
        debugLog({ category: 'message', phase: 'content', errorType: 'unknown' });
        return false;
    }
}

/**
 * Brave ブラウザ対応のメッセージ送信関数
 * エラーハンドリングを改善
 */
async function sendMessageToBrave(message) {
    // 軽量なコンテキストチェック（ログ出力なし）
    if (typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
        throw createTransientExtensionContextError();
    }

    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    const lastError = chrome.runtime.lastError;
                    if (isTransientExtensionContextError(lastError)) {
                        reject(createTransientExtensionContextError());
                    } else {
                        reject(new Error(getExtensionMessageErrorText(lastError) || 'Extension message failed'));
                    }
                } else {
                    resolve(response);
                }
            });
        } catch (e) {
            if (!isTransientExtensionContextError(e)) {
                debugLog({ category: 'message', phase: 'content', errorType: 'unknown', retryable: true });
            }
            reject(isTransientExtensionContextError(e) ? createTransientExtensionContextError() : e);
        }
    });
}

// バッジ生成機能(addAnalyzingBadge, addBadgeToImage)などは badge_controller.js に移動しました

// --- viewport 解析キュー ---
// IntersectionObserver からの要求はすぐに待機列へ入れ、空き枠があれば即時に解析する。
// 同時実行数と待機列の上限で負荷を抑え、画面外へ出た待機項目だけを取り除く。
// 開始済みの要求はキャッシュへ結果を保存できるよう完了させる。
// 同時実行の最終的な上限は background 側の集約ゲートが保証する。
// ここでの上限は pending message を無制限に積まないためのものである。

/** 待機列の最大長。これを超えたら viewport から最も遠いものを捨てる */
const MAX_PENDING_ANALYSIS_QUEUE = 32;

/** content script から同時に送る解析要求の上限 */
const MAX_INFLIGHT_VIEWPORT_ANALYSES = 4;

const viewportAnalysisQueue = {
    /** @type {Map<HTMLImageElement, {sequence: number}>} */
    pending: new Map(),
    /** @type {Set<HTMLImageElement>} */
    running: new Set(),
    sequence: 0,
    observer: null,
    drainScheduled: false,

    /**
     * viewport へ入った画像を待機列へ入れ、実行枠があればすぐに解析する。
     * @param {HTMLImageElement} img - 対象画像
     */
    enqueue(img) {
        if (this.running.has(img)) {
            logImageDiagnostic('queue-skip', img, {
                reason: 'already-running',
                running: true,
                processed: processedImages.has(img),
                activeRequest: activeImageRequests.has(img),
            });
            return;
        }
        if (this.pending.has(img)) {
            logImageDiagnostic('queue-skip', img, {
                reason: 'already-pending',
                running: false,
                processed: processedImages.has(img),
            });
            return;
        }
        this.sequence += 1;
        this.pending.set(img, { sequence: this.sequence, hover: false });
        logImageDiagnostic('queue-enqueue', img, {
            processed: processedImages.has(img),
            running: false,
        });
        this.enforceQueueLimit();
        this.scheduleDrain();
    },

    /** 同一observer callbackのenqueueをまとめ、LIFO選択後すぐに解析を開始する */
    scheduleDrain() {
        if (this.drainScheduled) return;
        this.drainScheduled = true;
        Promise.resolve().then(() => {
            this.drainScheduled = false;
            this.drain();
        });
    },

    /**
     * hover された画像を待機列の先頭へ昇格させ、停留待ちを飛ばして即座に開始する。
     * 待機列が長くても、ユーザーが見ている画像を待たせない。
     * @param {HTMLImageElement} img - 対象画像
     */
    promote(img) {
        const entry = this.pending.get(img);
        if (!entry) return;
        this.sequence += 1;
        const promotedEntry = { sequence: this.sequence, hover: true };
        // hover対象だけをpendingから取り出して開始する。全体drainは行わない。
        if (this.running.size < MAX_INFLIGHT_VIEWPORT_ANALYSES) {
            this.pending.delete(img);
            this.start(img, promotedEntry);
        } else {
            this.pending.set(img, promotedEntry);
        }
    },

    /**
     * 待機列が上限を超えたら viewport から最も遠いものを捨てる
     */
    enforceQueueLimit() {
        while (this.pending.size > MAX_PENDING_ANALYSIS_QUEUE) {
            let farthest = null;
            let farthestDistance = -1;
            for (const img of this.pending.keys()) {
                const distance = distanceFromViewportCenter(img);
                if (distance > farthestDistance) {
                    farthestDistance = distance;
                    farthest = img;
                }
            }
            if (!farthest) return;
            this.pending.delete(farthest);
            logImageDiagnostic('queue-skip', farthest, {
                reason: 'queue-overflow',
                processed: processedImages.has(farthest),
                running: false,
            });
            debugLog('[AI Meta Viewer] Analysis queue overflow, dropped farthest image:', {
                src: (farthest.src || '').substring(0, 80),
                distance: farthestDistance
            });
        }
    },

    /**
     * 画面外へ出た画像の解析を取り消す。
     * 待機中はキューから外し、開始済みの要求は結果をキャッシュするため完了させる。
     * @param {HTMLImageElement} img - 対象画像
     */
    cancel(img, reason = 'viewport-exit') {
        if (this.pending.delete(img)) {
            logImageDiagnostic('queue-cancel-pending', img, {
                reason,
                processed: processedImages.has(img),
                running: false,
            });
            debugLog('[AI Meta Viewer] Analysis cancelled before start:', (img.currentSrc || img.src || '').substring(0, 80));
            return;
        }
        if (!this.running.has(img)) return;
        if (reason === 'viewport-exit') {
            logImageDiagnostic('queue-skip', img, {
                reason: activeImageRequests.has(img) ? 'request-active' : 'request-inactive',
                processed: processedImages.has(img),
                activeRequest: activeImageRequests.has(img),
                running: true,
            });
            return;
        }
        cancelActiveAnalysis(img, reason);
    },

    /** 実行枠が空いている間、待機列から新しいものを取り出して開始する */
    drain() {
        while (this.running.size < MAX_INFLIGHT_VIEWPORT_ANALYSES && this.pending.size > 0) {
            const taken = this.takeNext();
            if (!taken) return;
            this.start(taken.img, taken.entry);
        }
    },

    /**
     * 次に開始する待機エントリを取り出す。
     * hover 昇格を最優先し、同条件では LIFO で新しいものを選ぶ。
     * @returns {{img: HTMLImageElement, entry: Object}|null}
     */
    takeNext() {
        let bestImg = null;
        let bestEntry = null;
        for (const [img, entry] of this.pending.entries()) {
            if (bestEntry === null) {
                bestImg = img;
                bestEntry = entry;
                continue;
            }
            if (entry.hover !== bestEntry.hover) {
                if (entry.hover) {
                    bestImg = img;
                    bestEntry = entry;
                }
                continue;
            }
            if (entry.sequence > bestEntry.sequence) {
                bestImg = img;
                bestEntry = entry;
            }
        }
        if (!bestImg) return null;
        this.pending.delete(bestImg);
        return { img: bestImg, entry: bestEntry };
    },

    /**
     * 解析を開始する。完了して確定したときだけ監視を解除する。
     * @param {HTMLImageElement} img - 対象画像
     * @param {Object} entry - 待機エントリ
     */
    start(img, entry) {
        this.running.add(img);
        const action = entry && entry.hover
            ? 'fetchImageMetadataForHover'
            : 'fetchImageMetadataForViewport';
        checkImageMetadata(img, { action })
            .catch((error) => {
                debugLog('[AI Meta Viewer] Viewport analysis failed:', error?.message);
            })
            .finally(() => {
                this.running.delete(img);
                const sourceChangedDuringAnalysis = imageSourceRechecks.has(img);
                imageSourceRechecks.delete(img);
                logImageDiagnostic('queue-finish', img, {
                    processed: processedImages.has(img),
                    activeRequest: activeImageRequests.has(img),
                    running: false,
                });
                clearActiveAnalysis(img);
                // 解析が確定した画像だけ監視を解除する。
                // 未確定(サイズ未定などで processedImages から外れた)ものは
                // 再度 viewport 判定を受けられるように監視を維持する。
                if (this.observer && img.isConnected) {
                    if (sourceChangedDuringAnalysis) {
                        this.observer.unobserve(img);
                        this.observer.observe(img);
                    } else if (processedImages.has(img)) {
                        this.observer.unobserve(img);
                    }
                }
                this.drain();
            });
    },
};

/**
 * viewport 中心からの距離を返す。待機列の間引き判断に使う。
 * @param {HTMLElement} element - 対象要素
 * @returns {number} - 距離 (取得できない場合は Infinity)
 */
function distanceFromViewportCenter(element) {
    try {
        const rect = element.getBoundingClientRect();
        const centerY = window.innerHeight / 2;
        const elementCenterY = rect.top + rect.height / 2;
        return Math.abs(elementCenterY - centerY);
    } catch (e) {
        return Number.POSITIVE_INFINITY;
    }
}

/**
 * DOMから削除された画像の解析状態と監視状態を解放する。
 * @param {HTMLImageElement} img - 対象画像
 */
function cleanupRemovedImage(img) {
    viewportAnalysisQueue.observer?.unobserve(img);
    const wasRunning = viewportAnalysisQueue.running.has(img);
    logImageDiagnostic('dom-remove', img, {
        reason: 'dom-removed',
        processed: processedImages.has(img),
        activeRequest: activeImageRequests.has(img),
        running: wasRunning,
    });
    viewportAnalysisQueue.cancel(img, 'dom-removed');
    if (!wasRunning) cancelActiveAnalysis(img, 'dom-removed');
    removeBadge(img);
    processedImages.delete(img);
    imageAnalyzedSources.delete(img);
    cleanupVideoElement(img);
}

function isVideoMetadataUrl(value) {
    if (typeof value !== 'string' || !value) return false;
    try {
        const url = new URL(value, document.baseURI);
        if (!['http:', 'https:', 'file:'].includes(url.protocol)) return false;
        return /\.(?:mp4|m4v|mov|webm|mkv)$/i.test(url.pathname);
    } catch (_) {
        return false;
    }
}

function getVideoLinkedAnchor(img) {
    if (!img || img.tagName !== 'IMG') return null;
    const anchor = img.closest('a[href]');
    const mediaType = String(anchor?.type || '').toLowerCase();
    let supportedScheme = false;
    try {
        supportedScheme = ['http:', 'https:', 'file:'].includes(new URL(anchor?.href || '', document.baseURI).protocol);
    } catch (_) { }
    return anchor && supportedScheme && (
        isVideoMetadataUrl(anchor.href) || /^video\/(?:mp4|webm|quicktime|x-matroska)$/.test(mediaType)
    )
        ? anchor
        : null;
}

function isVideoLinkedThumbnail(img) {
    return Boolean(getVideoLinkedAnchor(img));
}

function getVideoMetadataSource(element) {
    if (!element || !element.isConnected) return null;
    let value = '';
    if (element.tagName === 'VIDEO') {
        value = element.currentSrc || element.src || element.querySelector('source[src]')?.src || '';
    } else if (element.tagName === 'IMG') {
        value = getVideoLinkedAnchor(element)?.href || '';
    }
    if (!value) return null;
    try {
        const url = new URL(value, document.baseURI);
        return ['http:', 'https:', 'file:'].includes(url.protocol) ? url.href : null;
    } catch (_) {
        return null;
    }
}

function cancelVideoElement(element) {
    pendingVideoAnalyses.delete(element);
    const state = activeVideoAnalysisStates.get(element);
    if (!state || state.cancelled) return;
    state.cancelled = true;
    sendMessageToBrave({ action: 'cancelVideoMetadata', videoUrl: state.url }).catch(() => {});
}

function cleanupVideoElement(element) {
    if (!element) return;
    videoMetadataIntersectionObserver?.unobserve(element);
    observedVideoElements.delete(element);
    pendingVideoAnalyses.delete(element);
    cancelVideoElement(element);
    videoAnalyzedSources.delete(element);
    videoSelectedSources.delete(element);
    removeBadge(element);
    if (element.tagName === 'IMG') imageAnalyzedSources.delete(element);
}


// 動画 observation は ui.js 側に移した。動画候補が現れた時だけ UI を遅延注入する。
let lazyVideoObservationStarted = false;
let lazyVideoObservationActivated = false;
let lazyVideoDiscoveryObserver = null;
let lazyVideoRetryTimer = null;
let lazyVideoRetryAttempts = 0;
const VIDEO_OBSERVATION_RETRY_LIMIT = 3;
const VIDEO_OBSERVATION_RETRY_DELAY_MS = 1000;

function hasVideoCandidate() {
    if (!document.querySelector) return false;
    if (document.querySelector('video')) return true;
    return Array.from(document.querySelectorAll('a[href] img')).some(img => isVideoLinkedThumbnail(img));
}

function scheduleLazyVideoRetry() {
    if (lazyVideoRetryTimer !== null || lazyVideoRetryAttempts >= VIDEO_OBSERVATION_RETRY_LIMIT) return;
    lazyVideoRetryTimer = setTimeout(() => {
        lazyVideoRetryTimer = null;
        lazyVideoRetryAttempts += 1;
        activateLazyVideoObservation();
    }, VIDEO_OBSERVATION_RETRY_DELAY_MS);
}

function activateLazyVideoObservation() {
    if (lazyVideoObservationActivated) return false;
    if (!hasVideoCandidate()) return false;
    lazyVideoObservationActivated = true;
    ensureLazyUiModule().then(() => {
        if (typeof observeVideoMetadata !== 'function') {
            lazyVideoObservationActivated = false;
            scheduleLazyVideoRetry();
            return;
        }
        observeVideoMetadata();
        lazyVideoRetryAttempts = 0;
        if (lazyVideoDiscoveryObserver) {
            lazyVideoDiscoveryObserver.disconnect();
            lazyVideoDiscoveryObserver = null;
        }
    }).catch(() => {
        lazyVideoObservationActivated = false;
        scheduleLazyVideoRetry();
    });
    return true;
}

function startLazyVideoObservation() {
    if (lazyVideoObservationStarted) return;
    lazyVideoObservationStarted = true;
    const observer = new MutationObserver(() => {
        activateLazyVideoObservation();
    });
    lazyVideoDiscoveryObserver = observer;
    if (document.documentElement) {
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['href', 'src', 'type'],
        });
    }
    activateLazyVideoObservation();
}

/**
 * 画像監視を開始
 */
function observeImages() {
    // IntersectionObserverで可視範囲の画像のみ処理
    // 一度で unobserve せず、画面外へ出たイベントも受けて取り消しに使う
    const intersectionObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.target.tagName !== 'IMG') return;
            if (isVideoLinkedThumbnail(entry.target)) {
                viewportAnalysisQueue.cancel(entry.target, 'video-linked-thumbnail');
                return;
            }
            if (entry.isIntersecting) {
                viewportAnalysisQueue.enqueue(entry.target);
            } else {
                viewportAnalysisQueue.cancel(entry.target);
            }
        });
    }, {
        rootMargin: '50px' // 画面外50pxまで先読み
    });
    viewportAnalysisQueue.observer = intersectionObserver;

    const invalidateChangedImageSource = (img) => {
        const analyzedSource = imageAnalyzedSources.get(img);
        const currentSource = getCurrentImageSource(img);
        if (analyzedSource === undefined || analyzedSource === currentSource) return false;

        imageAnalyzedSources.delete(img);
        clearImageAnalyzingBadge(img);
        removeBadge(img);
        processedImages.delete(img);

        const running = viewportAnalysisQueue.running.has(img);
        if (running) imageSourceRechecks.add(img);
        const activeObserver = viewportAnalysisQueue.observer;
        activeObserver?.unobserve(img);
        if (!running && img.isConnected) activeObserver?.observe(img);

        logImageDiagnostic('source-selection-change', img, {
            reason: 'source-selection',
            sameSrc: false,
            processed: processedImages.has(img),
            activeRequest: activeImageRequests.has(img),
            running,
        });
        return true;
    };

    // currentSrc は src/srcset 属性が変わらなくても、viewportやDPRに応じて
    // 別候補へ切り替わる。load/errorとviewport変更で解析済み画像を照合する。
    const handleImageResourceChange = (event) => {
        if (event.target?.tagName !== 'IMG') return;
        const img = event.target;
        const sourceChanged = invalidateChangedImageSource(img);
        if (sourceChanged || event.type !== 'load' || !img.isConnected ||
            processedImages.has(img) || viewportAnalysisQueue.running.has(img) ||
            viewportAnalysisQueue.pending.has(img) || img.naturalWidth <= 0 || img.naturalHeight <= 0) {
            return;
        }
        // A prior viewport check may have skipped an image before its intrinsic
        // dimensions were available. Re-observe it once on load so the now-known
        // dimensions receive a fresh size judgment.
        const activeObserver = viewportAnalysisQueue.observer;
        activeObserver?.unobserve(img);
        activeObserver?.observe(img);
    };
    if (!sourceSelectionListenersRegistered) {
        document.addEventListener('load', handleImageResourceChange, true);
        document.addEventListener('error', handleImageResourceChange, true);

        let sourceSelectionCheckPending = false;
        const scheduleSourceSelectionCheck = () => {
            if (sourceSelectionCheckPending || processedImages.size === 0) return;
            sourceSelectionCheckPending = true;
            window.requestAnimationFrame(() => {
                sourceSelectionCheckPending = false;
                for (const img of processedImages.keys()) {
                    invalidateChangedImageSource(img);
                }
            });
        };
        window.addEventListener('resize', scheduleSourceSelectionCheck, { passive: true });
        window.addEventListener('orientationchange', scheduleSourceSelectionCheck, { passive: true });
        sourceSelectionListenersRegistered = true;
    }

    // hover された画像は待機列の先頭へ昇格させる
    document.addEventListener('mouseover', (event) => {
        const target = event.target;
        if (target && target.tagName === 'IMG') {
            viewportAnalysisQueue.promote(target);
        }
    }, { passive: true, capture: true });

    // 既存の画像を監視対象に追加
    document.querySelectorAll('img').forEach((img) => {
        intersectionObserver.observe(img);
    });

    // MutationObserverでデバウンス処理
    let debounceTimer = null;
    const pendingNodes = new Set();

    const processPendingNodes = () => {
        pendingNodes.forEach((node) => {
            if (node.tagName === 'IMG') {
                intersectionObserver.observe(node);
            } else {
                node.querySelectorAll?.('img').forEach((img) => {
                    intersectionObserver.observe(img);
                });
            }
        });
        pendingNodes.clear();
    };


    // 変更監視のデバウンス処理
    let timeoutId = null;
    let globalUpdateTimeoutId = null;

    const observerCallback = (mutations) => {
        // まず pendingNodes にノードを追加してからデバウンスタイマーを設定する
        // (setTimeout コールバックは非同期だが、意図を明確にするため先に追加)
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1) { // ELEMENT_NODE
                    pendingNodes.add(node);
                }
            });

            mutation.removedNodes.forEach((node) => {
                if (node.nodeType === 1) {
                    if (node.tagName === 'IMG') {
                        cleanupRemovedImage(node);
                    } else {
                        const imgs = node.querySelectorAll('img');
                        imgs.forEach(img => cleanupRemovedImage(img));
                    }
                }
            });
            if (mutation.type === 'attributes') {
                const target = mutation.target;
                if (target.tagName === 'IMG') {
                    if (['src', 'srcset'].includes(mutation.attributeName)) {
                        const sameSrc = mutation.oldValue === target.getAttribute(mutation.attributeName);
                        logImageDiagnostic('src-mutation', target, {
                            reason: 'src-change',
                            sameSrc,
                            processed: processedImages.has(target),
                            activeRequest: activeImageRequests.has(target),
                            running: viewportAnalysisQueue.running.has(target),
                        });
                        if (!sameSrc) {
                            imageAnalyzedSources.delete(target);
                            clearImageAnalyzingBadge(target);
                            const currentBadge = processedImages.get(target)?.badge;
                            const linkedVideoSource = getVideoMetadataSource(target);
                            if (currentBadge?._mediaType === 'video' && currentBadge._originalUrl === linkedVideoSource) {
                                processedImages.get(target)?.updatePosition?.();
                            } else {
                                removeBadge(target);
                                processedImages.delete(target);
                            }
                            if (viewportAnalysisQueue.running.has(target)) {
                                imageSourceRechecks.add(target);
                            }
                            intersectionObserver.unobserve(target);
                            pendingNodes.add(target);
                        }
                    } else if (['style', 'class', 'width', 'height', 'transform'].includes(mutation.attributeName)) {
                        const data = processedImages.get(target);
                        if (data && data.updatePosition) {
                            data.updatePosition();
                        }
                    }
                }
            }
        });

        if (timeoutId) {
            clearTimeout(timeoutId);
        }

        // 頻繁な実行を防ぐため、デバウンスを入れる
        // Pixivなどの高速スクロールに対応するため、100msから30msに短縮
        timeoutId = setTimeout(() => {
            processPendingNodes();
        }, 30);

        // フルスクリーンモーダルなどが開いた際にバッジの遮蔽状態を再計算する
        // DOMの追加・削除があった場合に実行
        // ここもデバウンスする
        if (globalUpdateTimeoutId) {
            clearTimeout(globalUpdateTimeoutId);
        }
        globalUpdateTimeoutId = setTimeout(() => {
            if (typeof window.forceUpdateAllBadges === 'function') {
                window.forceUpdateAllBadges();
            }
        }, 150); // processPendingNodesより少し後に実行

        spaUrlTracker?.schedule();
    };

    const setupObserver = () => {
        if (!document.body) {
            debugLog('[AI Meta Viewer] document.body not found, waiting for DOMContentLoaded');
            window.addEventListener('DOMContentLoaded', setupObserver, { once: true });
            return;
        }

        const observer = new MutationObserver(observerCallback);
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeOldValue: true,
            attributeFilter: ['src', 'srcset', 'style', 'class', 'width', 'height', 'transform']
        });

        // 初期ロード時の処理
        processPendingNodes();
    };

    setupObserver();
}

/**
 * 画像が直接表示されているかチェック
 * @returns {boolean}
 */
function isDirectImageView() {
    if (!document.body) return false; // bodyが存在しない場合はfalse

    // Content-Typeが画像の場合、または<img>タグが1つだけでbodyの直下にある場合
    const images = document.querySelectorAll('img');
    if (images.length === 1 && images[0].parentElement === document.body) {
        return true;
    }
    // bodyの子要素が<img>のみの場合
    if (document.body.children.length === 1 && document.body.children[0].tagName === 'IMG') {
        return true;
    }
    return false;
}



/**
 * Background Scriptからのメッセージを処理
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 拡張機能のコンテキストが無効化されている場合は処理を停止
    if (!isExtensionContextValid()) {
        debugLog({ category: 'message', phase: 'content', errorType: 'unknown', retryable: false });
        return false;
    }

    if (request.action === 'triggerScan') {
        // 拡張機能アイコンクリック時のスキャン実行
        debugLog('[AI Meta Viewer] Trigger scan requested');
        observeImages();
        startLazyVideoObservation();
        observeSiteSpecificElements();
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'debugSafetensorsLinks') {
        // デバッグ用：safetensorsリンクを手動検索
        const links = document.querySelectorAll('a[href*=".safetensors"]');
        debugLog(`[AI Meta Viewer] Found ${links.length} safetensors links:`, Array.from(links).map(l => l.href));
        if (links.length > 0) {
            // scanner.jsが読み込まれているかチェック
            if (typeof triggerSafetensorsScan === 'function') {
                triggerSafetensorsScan(Array.from(links));
            }
        }
        sendResponse({ success: true, count: links.length });
        return true;
    }

    if (request.action === 'clearMemoryCaches') {
        // メモリキャッシュのクリア
        debugLog('[AI Meta Viewer] Clearing memory caches');

        // contentMetadataCache をクリア
        const metadataCacheSize = contentMetadataCache.size;
        contentMetadataCache.clear();

        // processedImages をクリア (badge_controller.js で定義されている場合)
        let processedImagesSize = 0;
        if (typeof processedImages !== 'undefined') {
            processedImagesSize = processedImages.size;
            for (const img of processedImages.keys()) imageAnalyzedSources.delete(img);
            processedImages.clear();
        }
        for (const element of videoSelectedSources.keys()) {
            videoAnalyzedSources.delete(element);
            if (element.isConnected) {
                videoMetadataIntersectionObserver?.unobserve(element);
                videoMetadataIntersectionObserver?.observe(element);
            }
        }

        debugLog(`[AI Meta Viewer] Cleared ${metadataCacheSize} metadata cache entries and ${processedImagesSize} processed images`);
        sendResponse({
            success: true,
            clearedItems: {
                metadataCache: metadataCacheSize,
                processedImages: processedImagesSize
            }
        });
        return true;
    }

    if (request.action === 'showNotification') {
        // 通知表示 (ダウンロード失敗時など)
        if (request.message) {
            // 通知内容を診断ログへ渡さず、固定カテゴリだけをdebugLogへ渡す。
            debugLog({ category: 'message', phase: 'content', errorType: 'unknown' });
            // 実際の通知UIは必要に応じて実装
        }
        sendResponse({ success: true });
        return true;
    }
});
