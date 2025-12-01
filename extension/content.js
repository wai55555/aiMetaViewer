// content.js - コンテンツスクリプト

// 処理済み画像のWeakSet (メモリリーク防止)
const processedImages = new WeakSet();

// 画像URLごとのメタデータキャッシュ
const metadataCache = new Map();

/**
 * 画像のメタデータをチェックしてバッジを追加
 * @param {HTMLImageElement} img - 対象画像要素
 */
async function checkImageMetadata(img) {
    // 既に処理済み、または小さすぎる画像はスキップ
    if (processedImages.has(img) || img.width < 100 || img.height < 100) {
        return;
    }

    const src = img.src;
    if (!src) return;

    processedImages.add(img);

    try {
        let metadata = null;

        // キャッシュチェック
        if (metadataCache.has(src)) {
            metadata = metadataCache.get(src);
        } else {
            // Background Service Workerにメタデータ取得をリクエスト
            const response = await chrome.runtime.sendMessage({
                action: 'fetchImageMetadata',
                imageUrl: src
            });

            if (response.success && response.metadata) {
                metadata = response.metadata;

                // 空でない場合のみキャッシュ
                if (Object.keys(metadata).length > 0) {
                    metadataCache.set(src, metadata);
                }
            } else {
                // エラーまたはメタデータなし
                return;
            }
        }

        // メタデータが存在する場合、バッジを表示
        if (metadata && Object.keys(metadata).length > 0) {
            addBadgeToImage(img, metadata);
        }

    } catch (e) {
        // エラーは静かに無視 (CORS、ネットワークエラーなど)
        // console.debug('Failed to check metadata for:', src, e);
    }
}

/**
 * 画像にバッジを追加
 * @param {HTMLImageElement} img - 対象画像要素
 * @param {Object} metadata - メタデータ
 */
function addBadgeToImage(img, metadata) {
    // 親要素がposition: relativeでない場合、ラッパーが必要になる可能性があるが、
    // 既存のレイアウトを壊さないよう、画像の上にオーバーレイするコンテナを作成するアプローチをとる
    // または、画像の親要素に相対配置を適用する（副作用のリスクあり）

    // ここでは、画像の親要素にバッジを挿入し、画像の位置に合わせて配置する
    // ただし、画像が動的に動く場合やレスポンシブ対応が難しい

    // より堅牢なアプローチ:
    // 画像の直後にコンテナを挿入し、その中にバッジを絶対配置する

    const container = document.createElement('div');
    container.className = 'ai-meta-container';
    container.style.position = 'absolute';
    container.style.zIndex = '9990';

    // 画像の位置とサイズに合わせてコンテナを配置するためのロジックが必要だが、
    // シンプルに画像の親要素が相対配置可能ならそこに追加するのがベスト

    // 今回は、画像の親要素に `position: relative` を設定し（既存がstaticなら）、
    // バッジを画像要素の兄弟として追加する

    const parent = img.parentElement;
    if (!parent) return;

    const style = window.getComputedStyle(parent);
    if (style.position === 'static') {
        parent.style.position = 'relative';
    }

    const badge = createBadge(); // ui.jsの関数

    // バッジの位置調整 (画像の左上)
    // 画像自体にマージンやパディングがある場合を考慮する必要があるが、
    // 簡易的に親要素の左上に配置し、画像のオフセットを考慮する

    // 画像のオフセットを取得
    const imgLeft = img.offsetLeft;
    const imgTop = img.offsetTop;

    badge.style.left = `${imgLeft}px`;
    badge.style.top = `${imgTop}px`;

    // クリックイベント
    badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const modal = createModal(metadata); // ui.jsの関数
        document.body.appendChild(modal);
    });

    // 画像がロード完了しているか確認
    if (img.complete) {
        parent.appendChild(badge);
    } else {
        img.addEventListener('load', () => {
            // 再計算
            badge.style.left = `${img.offsetLeft}px`;
            badge.style.top = `${img.offsetTop}px`;
            parent.appendChild(badge);
        });
    }

    // ウィンドウリサイズ時に位置調整
    // (MutationObserverだけでは不十分な場合)
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
 * 直接表示された画像を処理
 */
async function handleDirectImageView() {
    const img = document.querySelector('img');
    if (!img) return;

    const src = img.src || window.location.href;

    try {
        // Background Service Workerにメタデータ取得をリクエスト
        const response = await chrome.runtime.sendMessage({
            action: 'fetchImageMetadata',
            imageUrl: src
        });

        if (response.success && response.metadata && Object.keys(response.metadata).length > 0) {
            createDirectImageUI(img, response.metadata);
        }
    } catch (e) {
        console.error('Failed to check metadata for direct image:', e);
    }
}

// 初期化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (isDirectImageView()) {
            handleDirectImageView();
        } else {
            observeImages();
        }
    });
} else {
    if (isDirectImageView()) {
        handleDirectImageView();
    } else {
        observeImages();
    }
}
