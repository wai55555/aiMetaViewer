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

// settings_loader.js で定義された window.debugLog を拡張
const baseDebugLog = window.debugLog;
window.debugLog = function (message, data = null) {
    // 基本のコンソール出力
    if (typeof baseDebugLog === 'function') {
        baseDebugLog(message, data);
    } else {
        // 万が一 baseDebugLog がない場合のフォールバック
        if (window.settings && window.settings.debugMode) {
            console.log(message, data);
        }
    }

    // debugMode が有効で、かつ file:// URL の場合のみ DOM に表示
    if (window.settings && window.settings.debugMode && window.location.protocol === 'file:') {
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
            logEntry.textContent = `[${timestamp}] ${message}${data ? ': ' + (typeof data === 'object' ? JSON.stringify(data).substring(0, 150) : data) : ''}`;

            debugLogContainer.appendChild(logEntry);

            // 最大数を超えたら古いログを削除
            while (debugLogContainer.children.length > MAX_DEBUG_LOGS) {
                debugLogContainer.removeChild(debugLogContainer.firstChild);
            }

            // 最新ログまでスクロール
            debugLogContainer.scrollTop = debugLogContainer.scrollHeight;
        }
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
                console.warn('[AI Meta Viewer] Extension context lost, attempting recovery...');

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
        handleDirectImageView();
    } else {
        debugLog('[AI Meta Viewer] Normal page view, starting image observation');
        observeImages();
        observeSiteSpecificElements();
    }

    extensionInitialized = true;
}

// 処理済み画像とバッジデータの管理、ResizeObserverなどは badge_controller.js に移動しました


// 画像URLごとのメタデータキャッシュ（content script内のメモリキャッシュ）
// 注意: scanner/core.js に同名の localMetadataCache が存在するため、
// content.js 側は contentMetadataCache として区別する
const contentMetadataCache = new Map();

// --- サイト別アダプター (互換性のためグローバルな SiteAdapters を使用) ---
// adapters.js に分離されました。

/**
 * 画像のメタデータをチェックしてバッジを追加
 * @param {HTMLImageElement} img - 対象画像要素
 */
async function checkImageMetadata(img) {
    debugLog('[AI Meta Viewer] checkImageMetadata() called for:', img.src);

    // 拡張機能のコンテキストが無効化されている場合は処理を停止
    if (!isExtensionContextValid()) {
        console.warn('[AI Meta Viewer] Extension context invalidated, stopping image metadata check');
        return;
    }

    // 重複チェック
    if (processedImages.has(img)) {
        debugLog(`[AI Meta Viewer] Image already processed, skipping: ${img.src.substring(0, 60)}...`);
        return;
    }

    debugLog(`[AI Meta Viewer] checkImageMetadata called for: ${img.src.substring(0, 60)}...`);

    const src = img.src;
    if (!src) {
        debugLog('[AI Meta Viewer] No src, skipping');
        return;
    }

    // ターゲットURLの解決
    let targetUrl = src;
    let isLinkedImage = false;

    // アダプターを使ってオリジナル画像を探索
    for (const adapter of SiteAdapters) {
        if (adapter.match()) {
            const resolvedUrl = adapter.resolve(img);
            if (resolvedUrl) {
                targetUrl = resolvedUrl;
                isLinkedImage = true;
                debugLog('[AI Meta Viewer] Adapter resolved URL:', {
                    originalSrc: img.src.substring(0, 80),
                    resolvedUrl: Array.isArray(resolvedUrl) ? resolvedUrl.map(u => u.substring(0, 80)) : resolvedUrl.substring(0, 80)
                });
                break; // 最初に見つかったものを採用
            }
        }
    }

    if (!isLinkedImage) {
        debugLog('[AI Meta Viewer] No adapter resolved URL for:', img.src.substring(0, 80));
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
    if (!isLinkedImage && pixelCount < settings.minPixelCount) {
        isTooSmall = true;
    }

    // リンク画像の場合でも、設定された最小サイズ未満は除外（デフォルト200x200）
    if (isLinkedImage && (actualWidth < settings.minImageSize || actualHeight < settings.minImageSize)) {
        isTooSmall = true;
    }

    // PixivやDiscordの場合は、サムネイルが小さくてもオリジナル画像にメタデータがある可能性が高いため、
    // アダプターで解決できた（isLinkedImage === true）場合のみサイズ制限を無視する
    if (isLinkedImage && (isPixiv || isDiscord)) {
        isTooSmall = false;
    }

    // [Discord専用: ユーザーアイコン対策]
    // リンク解決の有無に関わらず、表示サイズが極端に小さいものやAvatar画像は除外する
    if (isDiscord) {
        const displayWidth = img.width || img.clientWidth || actualWidth;
        const displayHeight = img.height || img.clientHeight || actualHeight;

        // 表示サイズが80x80以下のもの、またはURLがアバターのものは強制的に除外
        if ((displayWidth <= 80 && displayHeight <= 80) || (src && src.includes('/avatars/'))) {
            isTooSmall = true;
        }
    }

    if (isTooSmall) {
        debugLog('[AI Meta Viewer] Image too small, skipping:', {
            src: img.src.substring(0, 80),
            actualWidth,
            actualHeight,
            pixelCount,
            isLinkedImage
        });
        // 処理済みフラグを削除（画像読み込み後にサイズが確定してから再試行させるため）
        processedImages.delete(img);
        return;
    }

    // 処理済みフラグを立てる（重複チェック防止）
    // 注意: 処理中であることを示すマーカーを設定
    // 実際のバッジデータは addBadgeToImage() で設定される
    processedImages.set(img, null);

    // Pixivまたはローカルファイル、または全サイト設定が有効な場合、解析中バッジを表示
    const isLocalFile = targetUrl && (Array.isArray(targetUrl) ? targetUrl[0] : targetUrl).startsWith('file://');

    let shouldShowBadge = isPixiv || isLocalFile;
    if (settings.analyzeEverywhere) {
        shouldShowBadge = true;
    }

    let analyzingBadge = null;
    if (shouldShowBadge && settings.showAnalyzingBadge) {
        analyzingBadge = addAnalyzingBadge(img);
    }

    try {
        let metadata = null;
        let successUrl = null;

        // targetUrl が配列の場合（Pixivのサムネイルなど）、順次試行
        const urlsToTry = Array.isArray(targetUrl) ? targetUrl : [targetUrl];

        for (const url of urlsToTry) {
            // キャッシュチェック
            if (contentMetadataCache.has(url)) {
                metadata = contentMetadataCache.get(url);
                if (metadata && Object.keys(metadata).length > 0) {
                    successUrl = url;
                    break;
                }
                continue;
            }

            // メッセージペイロードの準備
            const message = {
                action: 'fetchImageMetadata',
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
                const response = await sendMessageToBrave(message);

                if (response && response.success && response.metadata) {
                    metadata = response.metadata;

                    // 空でない場合のみキャッシュして採用
                    if (Object.keys(metadata).length > 0) {
                        contentMetadataCache.set(url, metadata);
                        successUrl = url;
                        break; // 成功したらループを抜ける
                    }
                }
            } catch (e) {
                if (e.message && e.message.includes('Extension context invalidated')) {
                    if (settings.debugMode) {
                        console.warn('[AI Meta Viewer] Extension context invalidated during message send');
                    }
                    // 解析中バッジを削除してから処理を停止
                    if (analyzingBadge) {
                        removeAnalyzingBadge(analyzingBadge);
                    }
                    processedImages.delete(img);
                    return;
                }
                console.error('[AI Meta Viewer] Error sending message to background:', e);
                // 他のエラーの場合は次のURLを試行
                continue;
            }
        }

        // 解析中バッジを削除
        if (analyzingBadge) {
            removeAnalyzingBadge(analyzingBadge);
        }

        // --- メタデータフィルタリング (除外判定) ---

        if (metadata && Object.keys(metadata).length > 0) {
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

            // バッジを追加
            addBadgeToImage(img, metadata, successUrl || img.src);
        } else {
            // メタデータが空の場合は既存バッジを削除（リフレッシュ対策）
            debugLog('[AI Meta Viewer] No metadata found, removing badge if exists:', {
                src: img.src.substring(0, 80),
                targetUrl: Array.isArray(targetUrl) ? targetUrl.map(u => u.substring(0, 80)) : targetUrl.substring(0, 80),
                urlsToTry: urlsToTry.length
            });
            removeBadge(img);
        }

    } catch (error) {
        // エラー時も解析中バッジを削除
        if (analyzingBadge) {
            removeAnalyzingBadge(analyzingBadge);
        }

        if (settings.debugMode) {
            debugLog('[AI Meta Viewer] Error checking metadata:', error);
        }

        // エラー通知が有効な場合
        if (settings.errorNotification) {
            // 簡易的な通知（実際にはUIに表示する方が良いが、ここではコンソールのみ）
            // 必要に応じてトースト通知などを実装
        }

        processedImages.delete(img);
    }
}

// --- Civitai などの動的サイト用リトライロジック ---
let civitaiRetryCount = 0;
const MAX_CIVITAI_RETRIES = 7;
const CIVITAI_RETRY_INTERVAL_MS = 2000;
let civitaiMetadataFetchSucceeded = false;

/**
 * 実際のメタデータ取得コールバック
 */
const fetchMetadataCallback = (apiUrl) => {
    return sendMessageToBrave({
        action: 'fetchImageMetadata',
        imageUrl: apiUrl
    }).then(response => {
        if (response && response.success && response.metadata && Object.keys(response.metadata).length > 0) {
            debugLog('[AI Meta Viewer] Metadata fetched successfully:', Object.keys(response.metadata).join(', '));
            return response.metadata;
        }
        debugLog('[AI Meta Viewer] Metadata fetch returned empty or failed for:', apiUrl);
        return null;
    });
};

/**
 * safetensors のチェックを実行（深いスキャンとバッジ付与）
 */
function executeSafetensorsCheck() {
    debugLog('[AI Meta Viewer] Executing safetensors check');
    if (typeof executeDeepScanAndAddBadges === 'function') {
        executeDeepScanAndAddBadges(fetchMetadataCallback);
    }
}

/**
 * Civitai の API データが利用可能になるまで待機して実行するリトライループ
 */
function runCivitaiRetryCheck() {
    civitaiRetryCount++;
    debugLog('[AI Meta Viewer] Safetensors retry check', civitaiRetryCount, '/', MAX_CIVITAI_RETRIES);

    // deepScan を実行して、Civitai API URL が配置されるまで待つ
    if (typeof SiteAdapters !== 'undefined') {
        for (const adapter of SiteAdapters) {
            if (adapter.match() && typeof adapter.deepScan === 'function') {
                const candidates = adapter.deepScan(document);
                if (candidates && Array.isArray(candidates)) {
                    const safetensorsCandidates = candidates.filter(c => c.type === 'archive' && c.isCivitaiModel);
                    const civitaiApiCandidates = safetensorsCandidates.filter(c => c.modelVersionId);

                    if (civitaiApiCandidates.length > 0) {
                        debugLog('[AI Meta Viewer] Found Civitai API candidates:', civitaiApiCandidates.length);
                        civitaiMetadataFetchSucceeded = true;
                        break;
                    }
                }
            }
        }
    }

    if (civitaiMetadataFetchSucceeded || civitaiRetryCount >= MAX_CIVITAI_RETRIES) {
        if (civitaiMetadataFetchSucceeded) {
            debugLog('[AI Meta Viewer] Civitai API URL found, executing safetensors check');
            executeSafetensorsCheck();
        } else if (civitaiRetryCount >= MAX_CIVITAI_RETRIES) {
            debugLog('[AI Meta Viewer] WARNING: Max retries reached for safetensors check');
        }
        return;
    }

    // 次の試行をスケジュール
    debugLog('[AI Meta Viewer] Scheduling next safetensors check in', CIVITAI_RETRY_INTERVAL_MS, 'ms');
    setTimeout(runCivitaiRetryCheck, CIVITAI_RETRY_INTERVAL_MS);
}

/**
 * サイト別のアダプターからターゲットを取得してメタデータをチェック
 */
function observeSiteSpecificElements() {
    // Civitai等のサイトでは初回読み込み時にリトライチェックを開始
    if (typeof executeDeepScanAndAddBadges === 'function') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                setTimeout(() => {
                    debugLog('[AI Meta Viewer] DOMContentLoaded - starting safetensors check');
                    civitaiRetryCount = 0;
                    civitaiMetadataFetchSucceeded = false;
                    runCivitaiRetryCheck();
                }, 1000);
            });
        } else {
            setTimeout(() => {
                debugLog('[AI Meta Viewer] Page already loaded - starting safetensors check');
                civitaiRetryCount = 0;
                civitaiMetadataFetchSucceeded = false;
                runCivitaiRetryCheck();
            }, 1000);
        }
    }

    // 汎用的なsafetensorsリンク検知（全サイト対応）
    // 初回のみ実行（無限ループ防止）
    // 注意：deepScan処理の後に実行する（observeGenericSafetensorsLinks()がscanner.jsを起動させるため）
    for (const adapter of SiteAdapters) {
        if (adapter.match() && typeof adapter.getBadgeTargets === 'function') {
            const targets = adapter.getBadgeTargets(document);
            if (targets) {
                targets.forEach(el => checkMetadataForElement(el));
            }
        }
    }

    observeGenericSafetensorsLinks();
}

/**
 * SPA ナビゲーション検出 (ポーリング方式)
 * Civitai 等の SPA では DOM 変更と URL 変更のタイミングが一致しないことがある。
 * 200ms ごとの定期監視によって確実に URL 変化を捕捉し、一括処理を行う。
 */
function startSpaUrlPolling() {
    let lastKnownUrl = window.location.href;
    debugLog('[AI Meta Viewer] SPA URL Polling Monitor started. Current URL:', lastKnownUrl);

    const checkUrlChange = () => {
        const currentUrl = window.location.href;
        if (currentUrl !== lastKnownUrl) {
            debugLog('[AI Meta Viewer] SPA URL CHANGE DETECTED (Polling)');
            debugLog('  Old URL:', lastKnownUrl);
            debugLog('  New URL:', currentUrl);

            lastKnownUrl = currentUrl;

            debugLog('[AI Meta Viewer] Triggering batch cleanup for new version components...');

            const beforeMapSize = typeof processedImages !== 'undefined' ? processedImages.size : 0;

            // 1. 全てのバッジ（解析中含む）をDOMから削除
            const existingBadges = document.querySelectorAll('.ai-meta-badge, .ai-meta-badge-analyzing');
            existingBadges.forEach(b => {
                try { b.remove(); } catch (e) { debugLog('Error removing badge:', e); }
            });

            // 2. 処理済み管理マップをクリア（これにより新しい要素として認識させる）
            if (typeof processedImages !== 'undefined') {
                processedImages.clear();
                debugLog('[AI Meta Viewer] processedImages Map cleared.');
            }

            debugLog(`[AI Meta Viewer] Cleanup complete. Badges removed: ${existingBadges.length} (Current in DOM: ${document.querySelectorAll('.ai-meta-badge').length}), Map entries cleared: ${beforeMapSize}`);

            // 3. Civitai の再スキャンプロセスを開始 (少し待ってDOMが新しいURLに対応するのを待つ)
            setTimeout(() => {
                debugLog('[AI Meta Viewer] Triggering runCivitaiRetryCheck for updated page content...');
                civitaiRetryCount = 0;
                civitaiMetadataFetchSucceeded = false;
                runCivitaiRetryCheck();
            }, 800);
        }
    };

    if (window.aiMetaUrlInterval) clearInterval(window.aiMetaUrlInterval);
    window.aiMetaUrlInterval = setInterval(checkUrlChange, 200);
}

/**
 * 汎用的なsafetensorsリンクを監視
 */
let safetensorsObserver = null; // グローバル変数でObserverを管理

function observeGenericSafetensorsLinks() {
    // 既にObserverが作成されている場合は何もしない
    if (safetensorsObserver) {
        debugLog('[AI Meta Viewer] Safetensors observer already exists, skipping');
        return;
    }

    debugLog('[AI Meta Viewer] Starting generic safetensors link observation');

    // 既存のsafetensorsリンクをチェック
    const checkExistingLinks = () => {
        const safetensorsLinks = document.querySelectorAll('a[href*=".safetensors"]');
        safetensorsLinks.forEach(link => {
            if (!processedImages.has(link)) {
                debugLog('[AI Meta Viewer] Found safetensors link:', link.href);
                checkMetadataForElement(link);
            }
        });
    };

    // 初回チェック
    checkExistingLinks();

    // ページ読み込み完了後に再度チェック（遅延実行）
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => {
                debugLog('[AI Meta Viewer] DOMContentLoaded - rechecking safetensors links');
                checkExistingLinks();
            }, 500);
        });
    } else {
        // ページが既に読み込まれている場合
        setTimeout(() => {
            debugLog('[AI Meta Viewer] Delayed recheck - safetensors links');
            checkExistingLinks();
        }, 1000);
    }

    // SPA ナビゲーション検出を開始
    startSpaUrlPolling();

    // 新しく追加されるsafetensorsリンクを監視
    let debounceTimer = null;
    safetensorsObserver = new MutationObserver((mutations) => {
        // ノードの追加・削除の監視 (URLチェックは setInterval 側に任せる)
        mutations.forEach((mutation) => {
            if (mutation.addedNodes.length > 0) {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const links = [];
                        if (node.tagName === 'A' && node.href && node.href.includes('.safetensors')) links.push(node);
                        const innerLinks = node.querySelectorAll?.('a[href*=".safetensors"]');
                        if (innerLinks) innerLinks.forEach(l => links.push(l));

                        links.forEach(link => {
                            if (!processedImages.has(link)) {
                                debugLog('[AI Meta Viewer] New link added to DOM:', link.href);
                                checkMetadataForElement(link);
                            }
                        });
                    }
                });
            }

            if (mutation.removedNodes.length > 0) {
                mutation.removedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        const links = [];
                        if (node.tagName === 'A' && node.href && node.href.includes('.safetensors')) links.push(node);
                        const innerLinks = node.querySelectorAll?.('a[href*=".safetensors"]');
                        if (innerLinks) innerLinks.forEach(l => links.push(l));
                        links.forEach(link => processedImages.delete(link));
                    }
                });
            }
        });

        // デバウンス処理（safetensorsリンクの再チェック用）
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            checkExistingLinks();
        }, 500);
    });

    if (!document.body) {
        debugLog('[AI Meta Viewer] document.body not found, waiting for DOMContentLoaded to start safetensors observer');
        document.addEventListener('DOMContentLoaded', () => {
            safetensorsObserver.observe(document.body, { childList: true, subtree: true });
            debugLog('[AI Meta Viewer] Generic safetensors link observer started (deferred)');
        }, { once: true });
        return;
    }

    safetensorsObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    debugLog('[AI Meta Viewer] Generic safetensors link observer started');
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
        console.error('[AI Meta Viewer] Extension context check failed:', e);
        return false;
    }
}

/**
 * Brave ブラウザ対応のメッセージ送信関数
 * エラーハンドリングを改善
 */
async function sendMessageToBrave(message) {
    // 軽量なコンテキストチェック（ログ出力なし）
    if (!chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
        throw new Error('Extension context invalid');
    }

    return new Promise((resolve, reject) => {
        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    const error = chrome.runtime.lastError.message;
                    // コンテキスト無効化エラーの場合は特別に処理
                    if (error.includes('Extension context invalidated') ||
                        error.includes('receiving end does not exist') ||
                        error.includes('Could not establish connection')) {
                        reject(new Error('Extension context invalidated'));
                    } else {
                        reject(new Error(error));
                    }
                } else {
                    resolve(response);
                }
            });
        } catch (e) {
            const errorMsg = e.message || '';
            if (!errorMsg.includes('Extension context invalidated') &&
                !errorMsg.includes('receiving end does not exist') &&
                !errorMsg.includes('Could not establish connection')) {
                console.error('[AI Meta Viewer] Error in sendMessageToBrave:', e);
            }
            reject(e);
        }
    });
}

async function checkMetadataForElement(el) {
    // 拡張機能のコンテキストが無効化されている場合は処理を停止
    if (!isExtensionContextValid()) {
        // すでに読み込まれている設定があればデバッグログを表示
        if (window.settings && window.settings.debugMode) {
            console.warn('[AI Meta Viewer] Extension context invalidated, stopping metadata check');
        }
        return;
    }

    if (processedImages.has(el)) {
        const data = processedImages.get(el);
        if (data) return; // 既に処理済み
    }

    // 抽出対象URLの特定
    let url = null;
    if (el.tagName === 'A') {
        url = el.href;
        // ローカルファイルテスト時の相対パス解決
        if (window.location.protocol === 'file:' && document.title.includes('Civitai')) {
            const href = el.getAttribute('href');
            if (href && href.startsWith('/')) {
                url = 'https://civitai.com' + href;
            }
        }
    } else {
        return;
    }

    if (!url) return;

    // 処理済みフラグを一時的に立てる
    processedImages.set(el, { processing: true });

    try {
        const response = await sendMessageToBrave({
            action: 'fetchImageMetadata',
            imageUrl: url
        });

        if (response && response.success && response.metadata && Object.keys(response.metadata).length > 0) {
            addBadgeToElement(el, response.metadata, url);
        } else {
            // メタデータなし
            processedImages.delete(el);
        }
    } catch (e) {
        // エラーの種類に応じて処理を分ける
        if (e.message && e.message.includes('Extension context invalidated')) {
            console.warn('[AI Meta Viewer] Extension context invalidated during message send');
            // コンテキストが無効化された場合は、処理済みフラグを削除して再試行可能にする
            processedImages.delete(el);
            return;
        } else if (e.message && (e.message.includes('receiving end does not exist') ||
            e.message.includes('Could not establish connection'))) {
            // 接続エラーの場合も再試行可能にする
            console.warn('[AI Meta Viewer] Connection error, will retry later:', e.message);
            processedImages.delete(el);
            return;
        } else {
            // その他のエラーは通常のエラーとして処理
            console.error('[AI Meta Viewer] Error checking element metadata:', e);
            processedImages.delete(el);
        }
    }
}

// バッジ生成機能(addAnalyzingBadge, addBadgeToImage)などは badge_controller.js に移動しました

/**
 * 画像監視を開始
 */
function observeImages() {
    // IntersectionObserverで可視範囲の画像のみ処理
    const intersectionObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting && entry.target.tagName === 'IMG') {
                checkImageMetadata(entry.target);
                // 一度処理したら監視解除
                intersectionObserver.unobserve(entry.target);
            }
        });
    }, {
        rootMargin: '50px' // 画面外50pxまで先読み
    });

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
                        removeBadge(node);
                    } else {
                        const imgs = node.querySelectorAll('img');
                        imgs.forEach(img => removeBadge(img));
                    }
                }
            });
            if (mutation.type === 'attributes') {
                const target = mutation.target;
                if (target.tagName === 'IMG') {
                    if (mutation.attributeName === 'src') {
                        removeBadge(target);
                        pendingNodes.add(target);
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
            attributeFilter: ['src', 'style', 'class', 'width', 'height', 'transform']
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
 * 直接表示画像の処理
 */
function handleDirectImageView() {
    debugLog('[AI Meta Viewer] handleDirectImageView() called');
    if (!document.body) {
        debugLog('[AI Meta Viewer] No document.body, returning');
        return;
    }

    const img = document.querySelector('img');
    if (!img) {
        debugLog('[AI Meta Viewer] No img element found');
        return;
    }

    debugLog('[AI Meta Viewer] Found img element:', img.src);

    // スタイル調整
    document.body.style.backgroundColor = '#0e0e0e';
    document.body.style.display = 'flex';
    document.body.style.justifyContent = 'center';
    document.body.style.alignItems = 'center';
    document.body.style.minHeight = '100vh';
    document.body.style.margin = '0';

    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.boxShadow = '0 0 20px rgba(0,0,0,0.5)';

    debugLog('[AI Meta Viewer] Calling checkImageMetadata()');
    checkImageMetadata(img);
}


/**
 * Background Scriptからのメッセージを処理
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    // 拡張機能のコンテキストが無効化されている場合は処理を停止
    if (!isExtensionContextValid()) {
        console.warn('[AI Meta Viewer] Extension context invalidated, ignoring message');
        return false;
    }

    if (request.action === 'triggerScan') {
        // 拡張機能アイコンクリック時のスキャン実行
        debugLog('[AI Meta Viewer] Trigger scan requested');
        observeImages();
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
            processedImages.clear();
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
            console.log(`[AI Meta Viewer] Notification: ${request.message}`);
            // 実際の通知UIは必要に応じて実装
        }
        sendResponse({ success: true });
        return true;
    }
});