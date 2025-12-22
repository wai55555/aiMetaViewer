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
 * Remove badge and cleanup observers for an image
 * @param {HTMLImageElement} img 
 */
function removeBadge(img) {
    const data = processedImages.get(img);
    if (data) {
        if (data.badge) data.badge.remove();
        if (data.cleanup) data.cleanup();
        resizeObserver.unobserve(img);
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
 * バッジを画像に追加
 * @param {HTMLImageElement} img 
 * @param {Object} metadata 
 * @param {string} originalUrl 
 */
function addBadgeToImage(img, metadata, originalUrl) {
    // 既にバッジがある場合はクリーンアップして再作成（通常はここに来る前にremoveBadge呼ばれるはずだが念のため）
    if (processedImages.has(img)) {
        const existing = processedImages.get(img);
        if (existing && existing.badge) return; // 既にバッジがあるなら何もしない
    }

    const badge = createBadge(); // ui.jsの関数
    const isDirectImage = isDirectImageView();

    // ui.jsのupdateBadgeでツールチップなどを設定
    updateBadge(badge, metadata);

    // バッジにメタデータとオリジナルURLを保存
    badge._metadata = metadata;
    badge._originalUrl = originalUrl;

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

        // 登録
        processedImages.set(img, {
            badge: badge,
            updatePosition: updateBadgeOnDirectImage,
            cleanup: () => {
                img.removeEventListener('load', updateBadgeOnDirectImage);
                window.removeEventListener('resize', updateBadgeOnDirectImage);
            }
        });

    } else {
        // --- Webサイト表示の場合 (fixed配置でスクロールに追従) ---
        // position: fixed でビューポート座標を使用
        if (!document.body) return; // bodyが存在しない場合は何もしない

        badge.style.position = 'fixed';
        // badge.style.zIndex removed to respect CSS rules (Stacking Context managed in styles.css)
        document.body.appendChild(badge);

        let ticking = false;


        // 遮蔽検知用のカウンター（間引き処理）
        let occlusionCheckCounter = 0;

        // 位置更新関数
        const updatePosition = (forceOcclusionCheck = false) => {
            // 画像がDOMから削除されていたらバッジも削除
            if (!img.isConnected) {
                removeBadge(img);
                return;
            }

            // 画像のビューポート相対位置を取得
            const rect = img.getBoundingClientRect();

            // 画像が非表示、または画面外の場合はバッジも隠す
            // スクロールコンテナ内などでの部分表示も考慮
            if (rect.width === 0 || rect.height === 0 ||
                window.getComputedStyle(img).display === 'none' ||
                rect.bottom < 0 || rect.top > window.innerHeight ||
                rect.right < 0 || rect.left > window.innerWidth) {
                badge.style.display = 'none';
                return;
            }

            // バッジの高さ分、上にずらす
            const badgeHeight = 20;
            const top = rect.top - badgeHeight;
            const left = rect.left;

            badge.style.left = `${left}px`;
            badge.style.top = `${top}px`;

            // 遮蔽検知 (Occlusion Detection)
            occlusionCheckCounter++;
            if (forceOcclusionCheck || occlusionCheckCounter > 10) {
                occlusionCheckCounter = 0;

                // 画像の中心点を取得
                const cx = rect.left + rect.width / 2;
                const cy = rect.top + rect.height / 2;

                let currentlyOccluded = false;

                if (cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
                    // 判定精度を上げるため、一時的にバッジを非表示(visibility: hidden)にする
                    // display: noneだとレイアウトが変わる可能性があるためvisibility推奨だが、
                    // elementFromPointはvisibility: hiddenの要素を無視して奥の要素を取得する
                    const originalVisibility = badge.style.visibility;
                    badge.style.visibility = 'hidden';

                    const topElement = document.elementFromPoint(cx, cy);

                    // 戻す
                    badge.style.visibility = originalVisibility;

                    if (topElement) {
                        const isSelf = topElement === img || img.contains(topElement);
                        // バッジは隠しているので isBadge 判定は不要だが念のため
                        const isParent = topElement.contains(img);

                        // 画像がtopElementに含まれておらず、かつ自分自身でもない場合 -> 遮蔽されている
                        // (モーダル画像などが手前にある場合、topElementはそのモーダル画像になるはず)
                        if (!isSelf && !isParent) {
                            currentlyOccluded = true;
                        }
                    }
                }

                // 状態更新
                badge._isOccluded = currentlyOccluded;
            }

            // 遮蔽状態に基づいて表示切り替え
            if (badge._isOccluded) {
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

        // MutationObserverで検知できないレイアウト変更用
        // ResizeObserverからも呼ばれる

        // 初期位置設定
        if (img.complete) {
            updatePosition();
        } else {
            img.addEventListener('load', updatePosition, { once: true });
        }

        // スクロールイベントで位置を更新
        window.addEventListener('scroll', onScroll, { passive: true, capture: true });

        // ResizeObserverに登録
        resizeObserver.observe(img);

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

        // 登録
        processedImages.set(img, {
            badge: badge,
            updatePosition: updatePosition,
            cleanup: () => {
                img.removeEventListener('load', updatePosition);
                img.removeEventListener('mouseenter', showBadge);
                img.removeEventListener('mouseleave', hideBadge);
                window.removeEventListener('scroll', onScroll);
                resizeObserver.unobserve(img);
            }
        });
    }
}
