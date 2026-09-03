// badge_controller.js - UI Management for AI Meta Viewer

// 処理済み画像とバッジデータの対応マップ
// HTMLImageElement -> { badge: HTMLElement, updatePosition: Function, cleanup: Function }
window.processedImages = new Map();
const processedImages = window.processedImages;

/**
 * 全てのバッジに対して強制的に位置更新と遮蔽チェックを行う
 * (モーダルが開いた時などに使用)
 */
window.forceUpdateAllBadges = function () {
    for (const [img, data] of processedImages.entries()) {
        if (data && data.updatePosition) {
            data.updatePosition(true); // true = force occlusion check
        }
    }
};

// ResizeObserver for tracking image size/position changes
const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
        const img = entry.target;
        const data = processedImages.get(img);
        if (data && data.updatePosition) {
            // Use requestAnimationFrame to avoid "ResizeObserver loop limit exceeded"
            requestAnimationFrame(() => data.updatePosition());
        }
    }
});

/**
 * Remove badge and cleanup observers for an element (Image or other)
 * @param {HTMLElement} el 
 */
function removeBadge(el) {
    const data = processedImages.get(el);
    if (data) {
        if (data.badge) data.badge.remove();
        if (data.cleanup) data.cleanup();
        resizeObserver.unobserve(el);
        processedImages.delete(el);
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
            window.removeEventListener('scroll', onScroll, { capture: true });
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
            window.removeEventListener('scroll', onScroll, { capture: true });
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
 * バッジ要素を生成してメタデータ・URLを設定する
 * @param {Object} metadata
 * @param {string} originalUrl
 * @returns {HTMLElement}
 */
function createBadgeElement(metadata, originalUrl) {
    const badge = createBadge(); // ui.js
    updateBadge(badge, metadata); // ui.js
    badge.style.zIndex = '2147483640';
    badge._metadata = metadata;
    badge._originalUrl = originalUrl;
    return badge;
}

/**
 * バッジにクリックイベント（モーダル表示）を登録する
 * @param {HTMLElement} badge
 */
function attachBadgeClickHandler(badge) {
    badge.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const currentMetadata = badge._metadata;
        if (currentMetadata && document.body) {
            try {
                const modal = await createModal(currentMetadata, badge._originalUrl); // ui.js
                if (document.body) document.body.appendChild(modal);
            } catch (error) {
                if (typeof debugLog === 'function') {
                    debugLog('[AI Meta Viewer] Failed to create metadata modal.');
                }
            }
        }
    });
}

/**
 * 位置更新関数を生成する（fixed配置バッジ用）
 * @param {HTMLElement} el - 追跡対象の要素
 * @param {HTMLElement} badge
 * @param {Object} options - { isDiscord, isPixiv }
 * @returns {{ updatePosition: Function, onScroll: Function }}
 */
function createPositionUpdater(el, badge, { isDiscord = false, isPixiv = false } = {}) {
    let ticking = false;
    let occlusionCheckCounter = 0;
    badge._isOccluded = false;

    const updatePosition = (forceOcclusionCheck = false) => {
        try {
            if (!el.isConnected) {
                removeBadge(el);
                return;
            }

            const rect = el.getBoundingClientRect();

            if (rect.width === 0 || rect.height === 0 ||
                window.getComputedStyle(el).display === 'none' ||
                rect.bottom < 0 || rect.top > window.innerHeight ||
                rect.right < 0 || rect.left > window.innerWidth) {
                badge.style.display = 'none';
                return;
            }

            const badgeHeight = 20;
            badge.style.left = `${rect.left}px`;
            badge.style.top = `${rect.top - badgeHeight}px`;

            // 遮蔽検知 (Discord, Pixiv では無効化)
            if (!isDiscord && !isPixiv) {
                occlusionCheckCounter++;
                if (forceOcclusionCheck || occlusionCheckCounter > 10) {
                    occlusionCheckCounter = 0;

                    const cx = rect.left + rect.width / 2;
                    const cy = rect.top + rect.height / 2;
                    let currentlyOccluded = false;

                    if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
                        const originalVisibility = badge.style.visibility;
                        try {
                            badge.style.visibility = 'hidden';
                            const topElement = document.elementFromPoint(cx, cy);

                            if (topElement) {
                                const isSelf = topElement === el || el.contains(topElement);
                                const isParent = topElement.contains(el);

                                if (!isSelf && !isParent) {
                                    let parent = el.parentElement;
                                    let distance = 1;
                                    let isCloseRelative = false;
                                    while (parent && distance <= 3) {
                                        if (parent.contains(topElement)) {
                                            isCloseRelative = true;
                                            break;
                                        }
                                        parent = parent.parentElement;
                                        distance++;
                                    }
                                    if (!isCloseRelative) currentlyOccluded = true;
                                }
                            }
                        } finally {
                            badge.style.visibility = originalVisibility;
                        }
                    }
                    badge._isOccluded = currentlyOccluded;
                }
            }

            badge.style.display = badge._isOccluded ? 'none' : 'block';
        } finally {
            ticking = false;
        }
    };

    const onScroll = () => {
        if (!ticking) {
            window.requestAnimationFrame(updatePosition);
            ticking = true;
        }
    };

    return { updatePosition, onScroll };
}

/**
 * ホバー制御（表示/非表示の遅延）を設定する
 * @param {HTMLElement} el
 * @param {HTMLElement} badge
 * @param {Object} options - { isDiscord, isPixiv, updatePosition, showDelay }
 * @returns {{ showBadge: Function, hideBadge: Function }}
 */
function createHoverController(el, badge, { isDiscord = false, isPixiv = false, updatePosition, showDelay = 300 } = {}) {
    let hoverTimer = null;

    const showBadge = () => {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
            badge.classList.add('visible');
            updatePosition();
        }, showDelay);
    };

    const hideBadge = () => {
        if (hoverTimer) clearTimeout(hoverTimer);
        if (!isDiscord && !isPixiv) {
            hoverTimer = setTimeout(() => {
                badge.classList.remove('visible');
            }, 100);
        }
    };

    // Discord / Pixiv は常時表示
    if (isDiscord || isPixiv) {
        badge.classList.add('visible');
    }

    el.addEventListener('mouseenter', showBadge);
    el.addEventListener('mouseleave', hideBadge);
    badge.addEventListener('mouseenter', showBadge);
    badge.addEventListener('mouseleave', hideBadge);

    return { showBadge, hideBadge };
}

/**
 * 直接表示モード（isDirectImage）でバッジを配置する
 * @param {HTMLImageElement} img
 * @param {HTMLElement} badge
 */
function attachBadgeToDirectImage(img, badge) {
    const parent = img.parentElement;
    if (!parent) return;

    if (window.getComputedStyle(parent).position === 'static') {
        parent.style.position = 'relative';
    }

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

    processedImages.set(img, {
        badge,
        updatePosition: updateBadgeOnDirectImage,
        cleanup: () => {
            img.removeEventListener('load', updateBadgeOnDirectImage);
            window.removeEventListener('resize', updateBadgeOnDirectImage);
        }
    });
}

/**
 * Webサイト表示モードでバッジを配置する（fixed配置）
 * @param {HTMLImageElement} img
 * @param {HTMLElement} badge
 */
function attachBadgeToWebPage(img, badge) {
    if (!document.body) return;

    const isDiscord = window.location.hostname.includes('discord.com');
    const isPixiv = window.location.hostname.includes('pixiv.net');

    badge.style.position = 'fixed';
    document.body.appendChild(badge);

    const { updatePosition, onScroll } = createPositionUpdater(img, badge, { isDiscord, isPixiv });

    if (img.complete) {
        updatePosition();
    } else {
        img.addEventListener('load', updatePosition, { once: true });
    }

    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    resizeObserver.observe(img);

    const showDelay = (isDiscord || isPixiv) ? 0 : 300;
    const { showBadge, hideBadge } = createHoverController(img, badge, { isDiscord, isPixiv, updatePosition, showDelay });

    processedImages.set(img, {
        badge,
        updatePosition,
        cleanup: () => {
            img.removeEventListener('load', updatePosition);
            img.removeEventListener('mouseenter', showBadge);
            img.removeEventListener('mouseleave', hideBadge);
            window.removeEventListener('scroll', onScroll, { capture: true });
            resizeObserver.unobserve(img);
        }
    });

    debugLog('[AI Meta Viewer] Badge registered for image, total badges:', processedImages.size);
}

/**
 * バッジを画像に追加
 * @param {HTMLImageElement} img 
 * @param {Object} metadata 
 * @param {string} originalUrl 
 */
function addBadgeToImage(img, metadata, originalUrl) {
    // 既にバッジがある場合はチェック
    if (processedImages.has(img)) {
        const existing = processedImages.get(img);
        if (existing && existing.badge) {
            if (existing.badge._originalUrl === originalUrl) return;
            debugLog('[AI Meta Viewer] URL changed for the same element. Refreshing badge.', {
                old: existing.badge._originalUrl,
                new: originalUrl
            });
            removeBadge(img);
        }
    }

    const badge = createBadgeElement(metadata, originalUrl);

    const imgRect = img.getBoundingClientRect();
    debugLog('[AI Meta Viewer] Badge created for image:', {
        src: img.src.substring(0, 80),
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        displayWidth: img.width,
        displayHeight: img.height,
        rectTop: imgRect.top,
        rectLeft: imgRect.left,
        rectWidth: imgRect.width,
        rectHeight: imgRect.height,
        isDiscord: window.location.hostname.includes('discord.com'),
        isDirectImage: isDirectImageView()
    });

    attachBadgeClickHandler(badge);

    if (isDirectImageView()) {
        attachBadgeToDirectImage(img, badge);
    } else {
        attachBadgeToWebPage(img, badge);
    }
}

/**
 * 汎用的な要素にバッジを追加
 * @param {HTMLElement} el 
 * @param {Object} metadata 
 * @param {string} originalUrl 
 */
function addBadgeToElement(el, metadata, originalUrl) {
    if (processedImages.has(el)) {
        const existing = processedImages.get(el);
        if (existing && existing.badge) {
            if (existing.badge._originalUrl === originalUrl) return;
            removeBadge(el);
        }
    }

    if (!document.body) return;

    const badge = createBadgeElement(metadata, originalUrl);
    attachBadgeClickHandler(badge);

    badge.style.position = 'fixed';
    document.body.appendChild(badge);

    const { updatePosition, onScroll } = createPositionUpdater(el, badge);

    updatePosition();
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    resizeObserver.observe(el);

    const { showBadge, hideBadge } = createHoverController(el, badge, { updatePosition, showDelay: 100 });

    processedImages.set(el, {
        badge,
        updatePosition,
        cleanup: () => {
            el.removeEventListener('mouseenter', showBadge);
            el.removeEventListener('mouseleave', hideBadge);
            window.removeEventListener('scroll', onScroll, { capture: true });
            resizeObserver.unobserve(el);
        }
    });
}
/**
 * Background Scriptからのメッセージを処理
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'clearMemoryCaches') {
        // badge_controller.js のメモリキャッシュをクリア
        const processedImagesSize = processedImages.size;

        // 各バッジを適切にクリーンアップしてから削除
        for (const [element, data] of processedImages.entries()) {
            if (data) {
                if (data.badge) data.badge.remove();
                if (data.cleanup) data.cleanup();
                resizeObserver.unobserve(element);
            }
        }

        processedImages.clear();

        debugLog(`[AI Meta Viewer] Badge controller caches cleared: processedImages=${processedImagesSize}`);
        sendResponse({
            success: true,
            clearedItems: {
                processedImages: processedImagesSize
            }
        });
        return true;
    }
});