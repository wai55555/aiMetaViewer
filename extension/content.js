// content.js - コンテンツスクリプト

// デフォルト設定
const DEFAULT_SETTINGS = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000,
    excludedSites: []
};

// 現在の設定（起動時に読み込み）
let settings = { ...DEFAULT_SETTINGS };

// 設定を読み込む
async function loadSettings() {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    settings = stored;
}

// ワイルドカード (*, ?) を正規表現に変換
function wildcardToRegex(pattern) {
    // 特殊文字をエスケープ
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // * -> .*, ? -> . に変換
    const regexStr = '^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
    return new RegExp(regexStr, 'i'); // 大文字小文字を区別しない
}

// 現在のURLが除外対象かチェック
function isExcludedUrl() {
    if (!settings.excludedSites || settings.excludedSites.length === 0) {
        return false;
    }

    const currentUrl = window.location.href;
    const hostname = window.location.hostname;

    for (const pattern of settings.excludedSites) {
        try {
            const regex = wildcardToRegex(pattern);
            // URL全体またはホスト名でマッチング
            if (regex.test(currentUrl) || regex.test(hostname)) {
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
    // 除外サイトチェック
    if (isExcludedUrl()) {
        if (settings.debugMode) {
            console.log('[AI Meta Viewer] Site excluded by settings:', window.location.href);
        }
        return;
    }

    // 初期化実行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
});

function init() {
    if (isDirectImageView()) {
        handleDirectImageView();
    } else {
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
            const parentLink = img.closest('a');
            if (parentLink && parentLink.href && parentLink.href.includes('img-original')) {
                return parentLink.href;
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
    // 重複チェック
    if (processedImages.has(img)) return;

    const src = img.src;
    if (!src) return;

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

    // リンク画像の場合でも、極端に小さいアイコン等は除外（例: 100x100未満）
    if (isLinkedImage && (actualWidth < 100 || actualHeight < 100)) {
        return;
    }

    // 処理済みフラグを立てる（重複チェック防止）
    processedImages.set(img, null);

    try {
        let metadata = null;

        // キャッシュチェック
        if (metadataCache.has(targetUrl)) {
            metadata = metadataCache.get(targetUrl);
        } else {
            // メッセージペイロードの準備
            const message = {
                action: 'fetchImageMetadata',
                imageUrl: targetUrl
            };

            // ローカルファイル (file://) の場合、content.js側でデータを取得して送信
            if (targetUrl.startsWith('file://')) {
                // img要素を渡す
                const base64Data = await fetchLocalImage(img);
                if (base64Data) {
                    message.imageData = base64Data;
                }
            }

            // Background Service Workerにメタデータ取得をリクエスト
            const response = await chrome.runtime.sendMessage(message);

            if (response.success && response.metadata) {
                metadata = response.metadata;

                // 空でない場合のみキャッシュ
                if (Object.keys(metadata).length > 0) {
                    metadataCache.set(targetUrl, metadata);
                }
            } else {
                // エラーまたはメタデータなし
                processedImages.delete(img);
                return;
            }
        }

        // メタデータが存在する場合、バッジを追加
        if (metadata && Object.keys(metadata).length > 0) {
            addBadgeToImage(img, metadata);
        } else {
            // メタデータが空の場合は削除
            processedImages.delete(img);
        }

    } catch (e) {
        // エラー処理
        processedImages.delete(img);

        if (settings.errorNotification) {
            showErrorNotification(`Failed to load metadata: ${e.message}`);
        }
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
        if (currentMetadata) {
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
 * 直接表示された画像用のUIを作成
 * @param {HTMLImageElement} img - 画像要素
 * @param {Object} metadata - メタデータ
 */
function createDirectImageUI(img, metadata) {
    // オーバーレイコンテナを作成
    const overlay = document.createElement('div');
    overlay.style.cssText = `
        position: fixed;
        top: 10px;
        left: 10px;
        z-index: 10000;
    `;

    const badge = createBadge();
    badge.style.position = 'relative';
    badge.style.top = 'auto';
    badge.style.left = 'auto';

    // ui.jsのupdateBadgeでツールチップなどを設定
    updateBadge(badge, metadata);

    badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const modal = createModal(metadata);
        document.body.appendChild(modal);
    });

    overlay.appendChild(badge);
    document.body.appendChild(overlay);
}

/**
 * ローカル画像 (file://) をCanvas経由でBase64変換
 * @param {HTMLImageElement} img - 画像要素
 * @returns {Promise<string|null>} - Base64データ、失敗時はnull
 */
async function fetchLocalImage(img) {
    if (!img.src.startsWith('file://')) return null;

    try {
        // 画像が読み込まれていない場合はロードを待つ
        if (!img.complete) {
            await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
            });
        }

        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // CanvasからBase64データを取得
        // file:// プロトコルでは Tainted Canvas になる可能性があるが、
        // 拡張機能の権限設定によっては許可される場合がある
        return canvas.toDataURL('image/png');
    } catch (e) {
        console.error('[AI Meta Viewer] Failed to get image data via Canvas:', e);
        return null;
    }
}

/**
 * 直接表示された画像を処理
 */
async function handleDirectImageView() {
    const img = document.querySelector('img');
    if (!img) return;

    const src = img.src || window.location.href;

    try {
        const message = {
            action: 'fetchImageMetadata',
            imageUrl: src
        };

        // ローカルファイル対応
        if (src.startsWith('file://')) {
            // img要素を渡す
            const base64Data = await fetchLocalImage(img);
            if (base64Data) {
                message.imageData = base64Data;
            }
        }

        // Background Service Workerにメタデータ取得をリクエスト
        const response = await chrome.runtime.sendMessage(message);

        if (response.success && response.metadata && Object.keys(response.metadata).length > 0) {
            createDirectImageUI(img, response.metadata);
        }
    } catch (e) {
        console.error('Failed to check metadata for direct image:', e);
        if (settings.errorNotification) {
            showErrorNotification(`Failed to load metadata: ${e.message}`);
        }
    }
}


