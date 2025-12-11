// content.js - Content Script for AI Image Metadata Viewer

// スクリプト読み込み確認
console.log('[AI Meta Viewer] content.js loaded, URL:', window.location.href);

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

// 設定のデフォルト値
let settings = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000, // 500x500
    minImageSize: 200, // リンク付き画像の最小サイズ
    showAnalyzingBadge: true,
    analyzeEverywhere: false,
    excludedSites: [],
    ignoredMetadataKeys: ['XML:com.adobe.xmp'],
    ignoredSoftware: ['Adobe Photoshop', 'Adobe ImageReady', 'Celsys Studio Tool', 'GIMP', 'Paint.NET']
};

// 設定を読み込む
async function loadSettings() {
    try {
        const stored = await chrome.storage.sync.get(null); // すべての保存済み設定を取得
        settings = { ...settings, ...stored }; // デフォルト値に保存済み値を上書き
    } catch (e) {
        console.error('Failed to load settings:', e);
    }
}

// 除外サイト判定
function isExcludedUrl() {
    const currentUrl = window.location.href;
    const hostname = window.location.hostname;

    for (const pattern of settings.excludedSites) {
        if (!pattern) continue;

        // ワイルドカード変換 (* -> .*, ? -> .)
        // エスケープ処理も行う
        const regexStr = '^' + pattern
            .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 正規表現特殊文字をエスケープ
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.');

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
}

// 初期化時に設定を読み込む
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
    }
}

// 設定更新メッセージを受信
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'settingsUpdated') {
        settings = request.settings;
        // 設定変更時はリロードを推奨するか、動的に反映するが、
        // 除外設定の動的反映は複雑なため、次回ロード時から有効とするのが一般的
    }
});

// 処理済み画像とバッジの対応マップ (メモリリーク防止)
// HTMLImageElement -> HTMLElement (Badge)
const processedImages = new WeakMap();

// 画像URLごとのメタデータキャッシュ
const metadataCache = new Map();

// --- サイト別アダプター ---

const SiteAdapters = [
    // Discord
    {
        match: () => window.location.hostname.includes('discord.com'),
        resolve: (img) => {
            // 1. 親リンクからの判定 (cdn.discordapp.com)
            const parentLink = img.closest('a');
            if (parentLink && parentLink.href) {
                const href = parentLink.href;
                if (href.includes('cdn.discordapp.com') && parentLink.className.includes('originalLink')) {
                    return href;
                }
            }

            // 2. ネストされた構造からの判定
            let container = img.closest('[class*="imageWrapper"]');
            if (!container) {
                let parent = img.parentElement;
                for (let i = 0; i < 4; i++) {
                    if (!parent) break;
                    if (parent.querySelector('a[class*="originalLink"]')) {
                        container = parent;
                        break;
                    }
                    parent = parent.parentElement;
                }
            }

            if (container) {
                const discordLink = container.querySelector('a[class*="originalLink"]');
                if (discordLink && discordLink.href && discordLink.href.includes('cdn.discordapp.com')) {
                    return discordLink.href;
                }
            }
            return null;
        }
    },
    // Pixiv
    {
        match: () => window.location.hostname.includes('pixiv.net'),
        resolve: (img) => {
            // 1. 既存の img-original リンクチェック
            const parentLink = img.closest('a');
            if (parentLink && parentLink.href && parentLink.href.includes('img-original')) {
                return parentLink.href;
            }

            // 2. サムネイルからオリジナルURLを推測
            // 対応: ギャラリー (_square1200), ランキング (_master1200), その他サムネイル
            const src = img.src;
            if (src.includes('i.pximg.net') && (src.includes('img-master') || src.includes('custom-thumb'))) {
                // URL変換ロジック
                // 例1 (ギャラリー): https://i.pximg.net/c/250x250.../img-master/.../123_p0_square1200.jpg
                // 例2 (ランキング): https://i.pximg.net/c/480x960/img-master/.../123_p0_master1200.jpg
                // -> https://i.pximg.net/img-original/.../123_p0.png

                try {
                    const url = new URL(src);
                    let pathname = url.pathname;

                    // /c/xxx/ 部分を削除
                    pathname = pathname.replace(/^\/c\/[^/]+\//, '/');

                    // img-master または custom-thumb を img-original に置換
                    pathname = pathname.replace(/\/(img-master|custom-thumb)\//, '/img-original/');

                    // ファイル名から _square1200, _master1200 などのサフィックスを削除
                    // 例: 136040914_p0_square1200.jpg -> 136040914_p0
                    const match = pathname.match(/^(.+\/)(\d+_p\d+).*\.(jpg|png|webp|gif)$/);
                    if (match) {
                        const basePath = match[1]; // /img-original/img/2025/10/09/00/42/23/
                        const fileBase = match[2]; // 136040914_p0

                        // 拡張子候補: .png, .jpg, .webp の順で試行
                        const candidates = [
                            `${url.origin}${basePath}${fileBase}.png`,
                            `${url.origin}${basePath}${fileBase}.jpg`,
                            `${url.origin}${basePath}${fileBase}.webp`
                        ];

                        return candidates; // 配列を返す
                    }
                } catch (e) {
                    // URL解析失敗時は null
                }
            }

            return null;
        }
    },
    // 汎用 (拡張子チェック)
    {
        match: () => true, // 常にマッチ
        resolve: (img) => {
            const parentLink = img.closest('a');
            if (parentLink && parentLink.href) {
                const href = parentLink.href;
                const cleanHref = href.split('?')[0];
                if (/\.(png|jpg|jpeg|webp|avif)$/i.test(cleanHref)) {
                    return href;
                }
            }
            return null;
        }
    }
];

/**
 * 画像のメタデータをチェックしてバッジを追加
 * @param {HTMLImageElement} img - 対象画像要素
 */
async function checkImageMetadata(img) {
    debugLog('[AI Meta Viewer] checkImageMetadata() called for:', img.src);

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
            const response = await chrome.runtime.sendMessage(message);

            if (response.success && response.metadata) {
                metadata = response.metadata;

                // 空でない場合のみキャッシュして採用
                if (Object.keys(metadata).length > 0) {
                    metadataCache.set(url, metadata);
                    successUrl = url;
                    break; // 成功したらループを抜ける
                }
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
            addBadgeToImage(img, metadata);
        } else {
            // メタデータが空の場合は削除
            processedImages.delete(img);
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
 * 解析中バッジを追加
 * @param {HTMLImageElement} img 
 * @returns {Object} バッジ要素とクリーンアップ関数を含むオブジェクト
 */
function addAnalyzingBadge(img) {
    if (!document.body) return null; // bodyが存在しない場合は何もしない

    const badge = document.createElement('div');
    badge.className = 'ai-meta-badge ai-meta-badge-analyzing';
    badge.textContent = 'Analyzing';

    // Webサイト表示の場合 (fixed配置でスクロールに追従)
    badge.style.position = 'fixed';
    document.body.appendChild(badge);

    let ticking = false;

    // 位置更新関数
    const updatePosition = () => {
        // 画像がDOMから削除されていたらバッジも削除
        if (!img.isConnected) {
            badge.remove();
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onResize);
            return;
        }

        // 画像のビューポート相対位置を取得
        const rect = img.getBoundingClientRect();

        // バッジの高さ分、上にずらす
        const badgeHeight = 20;
        const top = rect.top - badgeHeight;
        const left = rect.left;

        badge.style.left = `${left}px`;
        badge.style.top = `${top}px`;

        // 画像が非表示、または画面外の場合はバッジも隠す
        if (rect.width === 0 || rect.height === 0 ||
            window.getComputedStyle(img).display === 'none' ||
            rect.bottom < 0 || rect.top > window.innerHeight) {
            badge.style.display = 'none';
        } else {
            badge.style.display = 'block';
        }

        ticking = false;
    };

    // スクロールイベントハンドラ
    const onScroll = () => {
        if (!ticking) {
            window.requestAnimationFrame(updatePosition);
            ticking = true;
        }
    };

    const onResize = () => {
        if (!ticking) {
            window.requestAnimationFrame(updatePosition);
            ticking = true;
        }
    };

    // 初期位置設定
    if (img.complete) {
        updatePosition();
    } else {
        img.addEventListener('load', updatePosition, { once: true });
    }

    // イベントリスナー登録
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onResize, { passive: true });

    // クリーンアップ用オブジェクトを返す
    return {
        element: badge,
        cleanup: () => {
            badge.remove();
            window.removeEventListener('scroll', onScroll);
            window.removeEventListener('resize', onResize);
        }
    };
}

/**
 * 解析中バッジを削除
 * @param {Object} badgeObj addAnalyzingBadgeが返したオブジェクト
 */
function removeAnalyzingBadge(badgeObj) {
    if (badgeObj && typeof badgeObj.cleanup === 'function') {
        badgeObj.cleanup();
    } else if (badgeObj instanceof HTMLElement) {
        // 古い形式（念のため）
        badgeObj.remove();
    }
}

/**
 * 画像にバッジを追加
 * @param {HTMLImageElement} img - 対象画像要素
 * @param {Object} metadata - メタデータ
 */
function addBadgeToImage(img, metadata) {
    // 既にバッジがある場合は何もしない
    if (processedImages.get(img)) return;

    const badge = createBadge(); // ui.jsの関数
    const isDirectImage = isDirectImageView();

    // ui.jsのupdateBadgeでツールチップなどを設定
    updateBadge(badge, metadata);

    // バッジにメタデータを保存
    badge._metadata = metadata;

    // クリックイベント
    badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const currentMetadata = badge._metadata;
        if (currentMetadata && document.body) {
            const modal = createModal(currentMetadata); // ui.jsの関数
            document.body.appendChild(modal);
        }
    });

    // バッジを管理マップに登録
    processedImages.set(img, badge);

    if (isDirectImage) {
        // --- 画像直接表示の場合 (従来通り) ---
        const parent = img.parentElement;
        if (!parent) return;

        const style = window.getComputedStyle(parent);
        if (style.position === 'static') {
            parent.style.position = 'relative';
        }

        // 画像の左上に配置
        const updateBadgeOnDirectImage = () => {
            badge.style.left = `${img.offsetLeft}px`;
            badge.style.top = `${img.offsetTop}px`;
        };

        updateBadgeOnDirectImage();
        parent.appendChild(badge);

        if (!img.complete) {
            img.addEventListener('load', updateBadgeOnDirectImage);
        }
        window.addEventListener('resize', updateBadgeOnDirectImage);

    } else {
        // --- Webサイト表示の場合 (fixed配置でスクロールに追従) ---
        // position: fixed でビューポート座標を使用
        if (!document.body) return; // bodyが存在しない場合は何もしない

        badge.style.position = 'fixed';
        document.body.appendChild(badge);

        let ticking = false;

        // 位置更新関数
        const updatePosition = () => {
            // 画像がDOMから削除されていたらバッジも削除
            if (!img.isConnected) {
                badge.remove();
                processedImages.delete(img);
                window.removeEventListener('scroll', onScroll);
                window.removeEventListener('resize', onResize);
                return;
            }

            // 画像のビューポート相対位置を取得
            const rect = img.getBoundingClientRect();

            // バッジの高さ分、上にずらす
            const badgeHeight = 20;
            const top = rect.top - badgeHeight;
            const left = rect.left;

            badge.style.left = `${left}px`;
            badge.style.top = `${top}px`;

            // 画像が非表示、または画面外の場合はバッジも隠す
            if (rect.width === 0 || rect.height === 0 ||
                window.getComputedStyle(img).display === 'none' ||
                rect.bottom < 0 || rect.top > window.innerHeight) {
                badge.style.display = 'none';
            } else {
                badge.style.display = 'block';
            }

            ticking = false;
        };

        // スクロールイベントハンドラ (requestAnimationFrameで最適化)
        const onScroll = () => {
            if (!ticking) {
                window.requestAnimationFrame(updatePosition);
                ticking = true;
            }
        };

        const onResize = () => {
            if (!ticking) {
                window.requestAnimationFrame(updatePosition);
                ticking = true;
            }
        };

        // 初期位置設定
        if (img.complete) {
            updatePosition();
        } else {
            img.addEventListener('load', updatePosition, { once: true });
        }

        // スクロールとリサイズイベントで位置を更新
        window.addEventListener('scroll', onScroll, { passive: true, capture: true });
        window.addEventListener('resize', onResize, { passive: true });

        // ホバー制御 (遅延表示)
        let hoverTimer = null;
        const showDelay = 300; // ms

        const showBadge = () => {
            if (hoverTimer) clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                badge.classList.add('visible');
                updatePosition(); // 表示時に位置を再計算
            }, showDelay);
        };

        const hideBadge = () => {
            if (hoverTimer) clearTimeout(hoverTimer);
            hoverTimer = setTimeout(() => {
                badge.classList.remove('visible');
            }, 100);
        };

        img.addEventListener('mouseenter', showBadge);
        img.addEventListener('mouseleave', hideBadge);
        badge.addEventListener('mouseenter', showBadge);
        badge.addEventListener('mouseleave', hideBadge);
    }
}

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

    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
                if (node.nodeType === 1) { // ELEMENT_NODE
                    pendingNodes.add(node);
                }
            });
        });

        // デバウンス: 100ms以内の連続した変更をまとめて処理
        if (debounceTimer) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(processPendingNodes, 100);
    });

    if (!document.body) {
        console.warn('[AI Meta Viewer] document.body is null, cannot observe images');
        return;
    }
    observer.observe(document.body, {
        childList: true,
        subtree: true
    });
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


