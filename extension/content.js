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

console.log(`[AI Meta Viewer] Content script loaded (${isFirefox ? 'Firefox' : 'Chrome'}):`, window.location.href);

// file:// URL では console.log が表示されないため、DOM に表示するデバッグ関数
let debugLogContainer = null;
const MAX_DEBUG_LOGS = 20; // 最大保持ログ数

function debugLog(message, data = null) {
    console.log(message, data); // 通常のコンソールにも出力（http/https では表示される）

    // debugMode が有効で、かつ file:// URL の場合のみ DOM に表示
    if (settings && settings.debugMode && window.location.protocol === 'file:') {
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
            logEntry.textContent = `[${timestamp}] ${message}${data ? ': ' + JSON.stringify(data).substring(0, 150) : ''}`;

            debugLogContainer.appendChild(logEntry);

            // 最大数を超えたら古いログを削除
            while (debugLogContainer.children.length > MAX_DEBUG_LOGS) {
                debugLogContainer.removeChild(debugLogContainer.firstChild);
            }

            // 最新ログまでスクロール
            debugLogContainer.scrollTop = debugLogContainer.scrollHeight;
        }
    }
}

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
                        console.log('[AI Meta Viewer] Extension context recovered, reinitializing...');
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
    console.log('[AI Meta Viewer] Settings loaded:', settings);

    // 除外サイトチェック
    if (isExcludedUrl()) {
        console.log('[AI Meta Viewer] Site excluded by settings:', window.location.href);
        return;
    }

    console.log('[AI Meta Viewer] Initializing extension on:', window.location.href);

    // 初期化実行
    if (document.readyState === 'loading') {
        console.log('[AI Meta Viewer] Document still loading, waiting for DOMContentLoaded');
        document.addEventListener('DOMContentLoaded', () => {
            init();
            startExtensionHealthCheck();
        });
    } else {
        console.log('[AI Meta Viewer] Document ready, calling init()');
        init();
        startExtensionHealthCheck();
    }
});

// 拡張機能の再初期化フラグ
let extensionInitialized = false;

function init() {
    console.log('[AI Meta Viewer] init() called');

    // 既に初期化済みの場合はスキップ
    if (extensionInitialized) {
        console.log('[AI Meta Viewer] Already initialized, skipping');
        return;
    }

    if (isDirectImageView()) {
        console.log('[AI Meta Viewer] Direct image view detected');
        handleDirectImageView();
    } else {
        console.log('[AI Meta Viewer] Normal page view, starting image observation');
        observeImages();
        observeSiteSpecificElements();
    }

    extensionInitialized = true;
}

// 処理済み画像とバッジデータの管理、ResizeObserverなどは badge_controller.js に移動しました


// 画像URLごとのメタデータキャッシュ
const metadataCache = new Map();

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
        console.log(`[DEBUG] Image already in processedImages, skipping: ${img.src.substring(0, 60)}...`);
        return;
    }

    console.log(`[DEBUG] checkImageMetadata called for: ${img.src.substring(0, 60)}...`);

    const src = img.src;
    if (!src) {
        console.log('[AI Meta Viewer] No src, skipping');
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
                console.log('[AI Meta Viewer] Adapter resolved URL:', {
                    originalSrc: img.src.substring(0, 80),
                    resolvedUrl: Array.isArray(resolvedUrl) ? resolvedUrl.map(u => u.substring(0, 80)) : resolvedUrl.substring(0, 80)
                });
                break; // 最初に見つかったものを採用
            }
        }
    }

    if (!isLinkedImage) {
        console.log('[AI Meta Viewer] No adapter resolved URL for:', img.src.substring(0, 80));
    }

    // サイズチェック
    const actualWidth = img.naturalWidth || img.width;
    const actualHeight = img.naturalHeight || img.height;
    const pixelCount = actualWidth * actualHeight;

    // リンク画像でない場合（直接表示など）は、設定された最小画素数でチェック
    if (!isLinkedImage && pixelCount < settings.minPixelCount) {
        return;
    }

    // リンク画像の場合でも、設定された最小サイズ未満は除外（デフォルト200x200）
    if (isLinkedImage && (actualWidth < settings.minImageSize || actualHeight < settings.minImageSize)) {
        console.log('[AI Meta Viewer] Image too small (linked image):', {
            src: img.src.substring(0, 80),
            actualWidth,
            actualHeight,
            minImageSize: settings.minImageSize
        });
        return;
    }

    // 処理済みフラグを立てる（重複チェック防止）
    // 注意: 処理中であることを示すマーカーを設定
    // 実際のバッジデータは addBadgeToImage() で設定される
    processedImages.set(img, null);

    // Pixivまたはローカルファイル、または全サイト設定が有効な場合、解析中バッジを表示
    const isPixiv = window.location.hostname.includes('pixiv.net');
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
            if (metadataCache.has(url)) {
                metadata = metadataCache.get(url);
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
                        metadataCache.set(url, metadata);
                        successUrl = url;
                        break; // 成功したらループを抜ける
                    }
                }
            } catch (e) {
                if (e.message && e.message.includes('Extension context invalidated')) {
                    console.warn('[AI Meta Viewer] Extension context invalidated during message send');
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
                        console.log('[AI Meta Viewer] Ignored image due to ignored metadata key');
                    }
                    processedImages.delete(img);
                    return;
                }
            }

            // 2. ソフトウェア名による除外 (Ignored Software)
            if (metadata['Software'] && settings.ignoredSoftware && Array.isArray(settings.ignoredSoftware) && settings.ignoredSoftware.length > 0) {
                const software = metadata['Software'];
                const isIgnoredSoftware = settings.ignoredSoftware.some(s => software.includes(s));

                if (isIgnoredSoftware) {
                    if (settings.debugMode) {
                        console.log('[AI Meta Viewer] Ignored software:', software);
                    }
                    processedImages.delete(img);
                    return;
                }
            }

            // バッジを追加
            addBadgeToImage(img, metadata, successUrl || img.src);
        } else {
            // メタデータが空の場合は削除（再解析対象から外す）
            processedImages.delete(img);
            console.log('[AI Meta Viewer] No metadata found for:', {
                src: img.src.substring(0, 80),
                targetUrl: Array.isArray(targetUrl) ? targetUrl.map(u => u.substring(0, 80)) : targetUrl.substring(0, 80),
                urlsToTry: urlsToTry.length
            });
        }

    } catch (error) {
        // エラー時も解析中バッジを削除
        if (analyzingBadge) {
            removeAnalyzingBadge(analyzingBadge);
        }

        if (settings.debugMode) {
            console.log('[AI Meta Viewer] Error checking metadata:', error);
        }

        // エラー通知が有効な場合
        if (settings.errorNotification) {
            // 簡易的な通知（実際にはUIに表示する方が良いが、ここではコンソールのみ）
            // 必要に応じてトースト通知などを実装
        }

        processedImages.delete(img);
    }
}

/**
 * サイト別のアダプターからターゲットを取得してメタデータをチェック
 */
function observeSiteSpecificElements() {
    // Civitai等のサイトではdeepScanを遅延実行
    // ページ読み込み完了後にdeepScanを実行（タイミング問題を回避）
    // 注意：observeGenericSafetensorsLinks()の前に実行する必要がある
    // （observeGenericSafetensorsLinks()がscanner.jsを起動させるため）
    if (typeof executeDeepScanAndAddBadges === 'function') {
        const executeSafetensorsCheck = () => {
            debugLog('[AI Meta Viewer] Executing safetensors check');
            executeDeepScanAndAddBadges();

            // deepScan実行後、候補のURLに対してメタデータを取得
            let safetensorsFound = false;
            for (const adapter of SiteAdapters) {
                if (adapter.match() && typeof adapter.deepScan === 'function') {
                    const candidates = adapter.deepScan(document);
                    if (candidates && Array.isArray(candidates)) {
                        const safetensorsCandidates = candidates.filter(c => c.type === 'archive' && c.isCivitaiModel);
                        debugLog('[AI Meta Viewer] Found', safetensorsCandidates.length, 'safetensors candidates');

                        if (safetensorsCandidates.length === 0) {
                            console.log('[AI Meta Viewer] No safetensors candidates found in deepScan');
                            continue;
                        }

                        safetensorsCandidates.forEach(candidate => {
                            safetensorsFound = true;

                            // Civitai API の download URL を使用してメタデータを取得
                            // candidate.modelVersionId から API URL を構築
                            let metadataUrl = candidate.url;
                            if (candidate.modelVersionId) {
                                // ページ上のダウンロードボタンから URL パラメータを抽出
                                // getBadgeTargets で取得したボタンから、既存の Civitai API URL を探す
                                const targets = adapter.getBadgeTargets?.(document) || [];
                                let apiUrlFromPage = null;

                                for (const target of targets) {
                                    const targetHref = target.href || '';
                                    // Civitai API URL パターンを検出（正確なパターンマッチ）
                                    // /models/{modelVersionId}? の形式で、false positive を防ぐ
                                    const modelVersionPattern = new RegExp(`/models/${candidate.modelVersionId}[?/]`);
                                    if (targetHref.includes('civitai.com/api/download/models/') &&
                                        modelVersionPattern.test(targetHref)) {
                                        apiUrlFromPage = targetHref;
                                        debugLog('[AI Meta Viewer] Found Civitai API URL from page button:', apiUrlFromPage);
                                        break;
                                    }
                                }

                                // ページから取得した URL を優先、なければデフォルトを構築
                                if (apiUrlFromPage) {
                                    metadataUrl = apiUrlFromPage;
                                    debugLog('[AI Meta Viewer] Using Civitai API URL from page:', metadataUrl);
                                } else {
                                    // フォールバック: デフォルトパラメータで構築（ページに URL がない場合）
                                    metadataUrl = `https://civitai.com/api/download/models/${candidate.modelVersionId}?type=Model&format=SafeTensor&size=pruned&fp=fp16`;
                                    debugLog('[AI Meta Viewer] Using default Civitai API URL:', metadataUrl);
                                }
                            } else {
                                debugLog('[AI Meta Viewer] Using original safetensors URL:', metadataUrl);
                            }

                            debugLog('[AI Meta Viewer] Fetching metadata for safetensors:', metadataUrl);
                            debugLog('[AI Meta Viewer] Candidate filename:', candidate.filename);

                            // URLを直接処理（checkImageMetadataではなく、直接メタデータ取得）
                            sendMessageToBrave({
                                action: 'fetchImageMetadata',
                                imageUrl: metadataUrl
                            }).then(response => {
                                if (response && response.success && response.metadata && Object.keys(response.metadata).length > 0) {
                                    debugLog('[AI Meta Viewer] Got metadata for safetensors:', candidate.filename);
                                    debugLog('[AI Meta Viewer] Metadata keys:', Object.keys(response.metadata).join(', '));

                                    // メタデータを取得したら、ダウンロードボタンを探してバッジを追加
                                    const targets = adapter.getBadgeTargets?.(document) || [];
                                    debugLog('[AI Meta Viewer] Found', targets.length, 'download button targets for badge');

                                    if (targets.length === 0) {
                                        console.warn('[AI Meta Viewer] WARNING: No download button targets found! getBadgeTargets returned empty array');
                                        return;
                                    }

                                    let badgeAdded = false;
                                    targets.forEach((el, index) => {
                                        const elInfo = `[${index}] ${el.tagName} href="${el.href || 'N/A'}" text="${(el.textContent || '').substring(0, 50)}"`;

                                        if (typeof processedImages === 'undefined') {
                                            console.error('[AI Meta Viewer] ERROR: processedImages is undefined!');
                                            return;
                                        }

                                        if (processedImages.has(el)) {
                                            debugLog('[AI Meta Viewer] Element already processed:', elInfo);
                                            return;
                                        }

                                        if (typeof addBadgeToElement !== 'function') {
                                            console.error('[AI Meta Viewer] ERROR: addBadgeToElement is not a function!');
                                            return;
                                        }

                                        debugLog('[AI Meta Viewer] Adding badge to element:', elInfo);
                                        try {
                                            addBadgeToElement(el, response.metadata, candidate.url);
                                            badgeAdded = true;
                                            debugLog('[AI Meta Viewer] Badge added successfully to:', elInfo);
                                        } catch (e) {
                                            console.error('[AI Meta Viewer] ERROR adding badge:', e.message);
                                        }

                                        processedImages.set(el, {
                                            badge: {
                                                metadata: response.metadata,
                                                url: candidate.url
                                            }
                                        });
                                    });

                                    if (badgeAdded) {
                                        debugLog('[AI Meta Viewer] Safetensors badge added successfully');
                                    } else {
                                        console.warn('[AI Meta Viewer] WARNING: No badge was added to any element');
                                    }
                                } else {
                                    console.warn('[AI Meta Viewer] WARNING: Metadata fetch failed or empty', {
                                        success: response?.success,
                                        hasMetadata: !!response?.metadata,
                                        metadataKeys: response?.metadata ? Object.keys(response.metadata).length : 0,
                                        error: response?.error,
                                        fullResponse: response
                                    });
                                }
                            }).catch(e => {
                                console.error('[AI Meta Viewer] ERROR fetching safetensors metadata:', e.message);
                            });
                        });
                    } else {
                        debugLog('[AI Meta Viewer] deepScan returned no candidates');
                    }
                }
            }
            return safetensorsFound;
        };

        // 2秒ごとに確認、最大10秒間（5回試行）
        let retryCount = 0;
        const maxRetries = 5;
        const retryInterval = 2000; // 2秒

        let metadataFetchSucceeded = false;

        const retryCheck = () => {
            retryCount++;
            debugLog('[AI Meta Viewer] Safetensors retry check', retryCount, '/', maxRetries);

            // deepScan を実行して、Civitai API URL が配置されるまで待つ
            for (const adapter of SiteAdapters) {
                if (adapter.match() && typeof adapter.deepScan === 'function') {
                    const candidates = adapter.deepScan(document);
                    if (candidates && Array.isArray(candidates)) {
                        const safetensorsCandidates = candidates.filter(c => c.type === 'archive' && c.isCivitaiModel);

                        // Civitai API URL を持つ候補を探す
                        const civitaiApiCandidates = safetensorsCandidates.filter(c => c.modelVersionId);

                        if (civitaiApiCandidates.length > 0) {
                            debugLog('[AI Meta Viewer] Found Civitai API candidates:', civitaiApiCandidates.length);
                            metadataFetchSucceeded = true;
                            break; // Civitai API URL が見つかったら終了
                        }
                    }
                }
            }

            if (metadataFetchSucceeded || retryCount >= maxRetries) {
                if (metadataFetchSucceeded) {
                    // Civitai API URL が見つかった場合は優先的に実行
                    debugLog('[AI Meta Viewer] Civitai API URL found, executing safetensors check');
                    executeSafetensorsCheck();
                } else if (retryCount >= maxRetries) {
                    // 最大試行回数に達した場合のみ警告
                    console.warn('[AI Meta Viewer] WARNING: Max retries reached for safetensors check');
                }
                return; // 見つかったか、最大試行回数に達したら終了
            }

            // 次の試行をスケジュール
            debugLog('[AI Meta Viewer] Scheduling next safetensors check in', retryInterval, 'ms');
            setTimeout(retryCheck, retryInterval);
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                // Civitaiはページ読み込み後も動的にボタンを生成するため、より長く待つ
                setTimeout(() => {
                    debugLog('[AI Meta Viewer] DOMContentLoaded - starting safetensors check');
                    retryCheck();
                }, 1000); // 1秒待機してから開始
            });
        } else {
            // ページが既に読み込まれている場合
            setTimeout(() => {
                debugLog('[AI Meta Viewer] Page already loaded - starting safetensors check');
                retryCheck();
            }, 1000); // 1秒待機してから開始
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

    // 新しく追加されるsafetensorsリンクを監視
    // バージョン切り替え時の画面更新も検出
    let debounceTimer = null;
    let largeChangeDetected = false;

    safetensorsObserver = new MutationObserver((mutations) => {
        // 大規模な変更を検出（複数のノード削除 = バージョン切り替え）
        let removedNodeCount = 0;
        let addedNodeCount = 0;

        mutations.forEach((mutation) => {
            removedNodeCount += mutation.removedNodes.length;
            addedNodeCount += mutation.addedNodes.length;

            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    // 追加されたノード自体がsafetensorsリンクの場合
                    if (node.tagName === 'A' && node.href && node.href.includes('.safetensors')) {
                        if (!processedImages.has(node)) {
                            debugLog('[AI Meta Viewer] New safetensors link detected:', node.href);
                            checkMetadataForElement(node);
                        }
                    }

                    // 追加されたノード内のsafetensorsリンクをチェック
                    const innerLinks = node.querySelectorAll?.('a[href*=".safetensors"]');
                    innerLinks?.forEach(link => {
                        if (!processedImages.has(link)) {
                            debugLog('[AI Meta Viewer] New inner safetensors link detected:', link.href);
                            checkMetadataForElement(link);
                        }
                    });
                }
            });

            // 削除されたノードからバッジを削除
            mutation.removedNodes.forEach((node) => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    if (node.tagName === 'A' && node.href && node.href.includes('.safetensors')) {
                        processedImages.delete(node);
                    }
                    const innerLinks = node.querySelectorAll?.('a[href*=".safetensors"]');
                    innerLinks?.forEach(link => {
                        processedImages.delete(link);
                    });
                }
            });
        });

        // 大規模な変更を検出（バージョン切り替え時）
        if (removedNodeCount > 5 && addedNodeCount > 5) {
            largeChangeDetected = true;
            debugLog('[AI Meta Viewer] Large DOM change detected - likely version switch');
        }

        // デバウンス処理
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }

        debounceTimer = setTimeout(() => {
            // 大規模な変更が検出された場合、deepScanを再実行
            if (largeChangeDetected) {
                debugLog('[AI Meta Viewer] Executing deepScan after version switch');
                if (typeof executeDeepScanAndAddBadges === 'function') {
                    executeDeepScanAndAddBadges();
                }
                largeChangeDetected = false;
            }

            // 新しいsafetensorsリンクをチェック
            checkExistingLinks();
        }, 300);
    });

    safetensorsObserver.observe(document.body, {
        childList: true,
        subtree: true
    });

    debugLog('[AI Meta Viewer] Generic safetensors link observer started');
}

/**
 * 画像以外の要素のメタデータをチェックしてバッジを追加
 */
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
            console.error('[AI Meta Viewer] Error in sendMessageToBrave:', e);
            reject(e);
        }
    });
}

async function checkMetadataForElement(el) {
    // 拡張機能のコンテキストが無効化されている場合は処理を停止
    if (!isExtensionContextValid()) {
        console.warn('[AI Meta Viewer] Extension context invalidated, stopping metadata check');
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
        if (timeoutId) {
            clearTimeout(timeoutId);
        }

        // 頻繁な実行を防ぐため、100msのデバウンスを入れる
        timeoutId = setTimeout(() => {
            processPendingNodes();
        }, 100);

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

        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1) { // ELEMENT_NODE
                    pendingNodes.add(node);
                }
            });

            // サイト個別の要素チェックは初期化時のみ実行（無限ループ防止）
            // observeSiteSpecificElements(); // この行を削除

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
    };

    const observer = new MutationObserver(observerCallback);
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'style', 'class', 'width', 'height', 'transform']
    });

    // 初期ロード時の処理
    processPendingNodes();
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
        console.log('[AI Meta Viewer] No document.body, returning');
        return;
    }

    const img = document.querySelector('img');
    if (!img) {
        console.log('[AI Meta Viewer] No img element found');
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

    console.log('[AI Meta Viewer] Calling checkImageMetadata()');
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
        console.log(`[AI Meta Viewer] Found ${links.length} safetensors links:`, Array.from(links).map(l => l.href));
        links.forEach(link => checkMetadataForElement(link));
        sendResponse({ success: true, count: links.length });
        return true;
    }

    if (request.action === 'clearMemoryCaches') {
        // メモリキャッシュのクリア
        debugLog('[AI Meta Viewer] Clearing memory caches');

        // metadataCache をクリア
        const metadataCacheSize = metadataCache.size;
        metadataCache.clear();

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