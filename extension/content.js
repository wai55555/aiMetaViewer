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
        document.addEventListener('DOMContentLoaded', init);
    } else {
        console.log('[AI Meta Viewer] Document ready, calling init()');
        init();
    }
});

function init() {
    console.log('[AI Meta Viewer] init() called');
    if (isDirectImageView()) {
        console.log('[AI Meta Viewer] Direct image view detected');
        handleDirectImageView();
    } else {
        console.log('[AI Meta Viewer] Normal page view, starting image observation');
        observeImages();
        observeSiteSpecificElements();
    }
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
        debugLog('[AI Meta Viewer] Image already processed, skipping');
        return;
    }

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
                break; // 最初に見つかったものを採用
            }
        }
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
        return;
    }

    // 処理済みフラグを立てる（重複チェック防止）
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
            // メタデータが空の場合は削除（再解析対象から外すため、nullを入れる）
            // ただし、画像が変更されたら再解析したいので、processedImagesには入れない方が良いかも？
            // いや、毎回チェックするのは負荷が高いので、"メタデータなし"として登録する。
            processedImages.set(img, { badge: null });
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
    for (const adapter of SiteAdapters) {
        if (adapter.match() && typeof adapter.getBadgeTargets === 'function') {
            const targets = adapter.getBadgeTargets(document);
            if (targets) {
                targets.forEach(el => checkMetadataForElement(el));
            }
        }
    }
}

/**
 * 画像以外の要素のメタデータをチェックしてバッジを追加
 */
/**
 * 拡張機能のコンテキストが有効かどうかをチェック
 * Brave ブラウザ対応版
 */
function isExtensionContextValid() {
    try {
        // Braveでは chrome.runtime.id が undefined になることがある
        if (!chrome || !chrome.runtime) {
            return false;
        }

        // chrome.runtime.id の存在確認
        if (typeof chrome.runtime.id === 'undefined') {
            console.warn('[AI Meta Viewer] chrome.runtime.id is undefined - possible Brave browser issue');
            return false;
        }

        // sendMessage 関数の存在確認
        if (typeof chrome.runtime.sendMessage !== 'function') {
            console.warn('[AI Meta Viewer] chrome.runtime.sendMessage is not available');
            return false;
        }

        return true;
    } catch (e) {
        console.error('[AI Meta Viewer] Extension context check failed:', e);
        return false;
    }
}

/**
 * Brave ブラウザ対応のメッセージ送信関数
 */
async function sendMessageToBrave(message, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            if (!isExtensionContextValid()) {
                throw new Error('Extension context invalid');
            }

            return new Promise((resolve, reject) => {
                chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(response);
                    }
                });
            });
        } catch (e) {
            console.warn(`[AI Meta Viewer] Message send attempt ${i + 1} failed:`, e.message);

            if (i === retries - 1) {
                throw e;
            }

            // 短い待機後にリトライ
            await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
        }
    }
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
    processedImages.set(el, null);

    try {
        const response = await sendMessageToBrave({
            action: 'fetchImageMetadata',
            imageUrl: url
        });

        if (response && response.success && response.metadata && Object.keys(response.metadata).length > 0) {
            addBadgeToElement(el, response.metadata, url);
        } else {
            // メタデータなし
            processedImages.set(el, { badge: null });
        }
    } catch (e) {
        if (e.message && e.message.includes('Extension context invalidated')) {
            console.warn('[AI Meta Viewer] Extension context invalidated during message send');
            // コンテキストが無効化された場合は、以降の処理を停止
            return;
        }
        console.error('[AI Meta Viewer] Error checking element metadata:', e);
        processedImages.delete(el);
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

            // サイト個別の要素チェックも Mutation 時に行う
            observeSiteSpecificElements();

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