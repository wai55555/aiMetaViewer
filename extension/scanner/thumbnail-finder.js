// scanner/thumbnail-finder.js - サムネイル画像検出

/**
 * 動画要素の周辺からサムネイル画像を検出
 * @param {HTMLVideoElement} video - 動画要素
 * @returns {string|null} - サムネイル画像のURL、見つからない場合はnull
 */
function findVideoThumbnail(video) {
    // 1. poster属性をチェック
    if (video.poster) {
        return video.poster;
    }

    // 2. 親要素内の画像を検索
    let parent = video.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
        const images = parent.querySelectorAll('img');
        for (const img of images) {
            if (img !== video && img.src && img.src.startsWith('http')) {
                return img.src;
            }
        }
        parent = parent.parentElement;
    }

    // 3. 兄弟要素内の画像を検索
    if (video.parentElement) {
        const siblings = Array.from(video.parentElement.children);
        for (const sibling of siblings) {
            if (sibling !== video && sibling.tagName === 'IMG' && sibling.src) {
                return sibling.src;
            }
            const nestedImages = sibling.querySelectorAll('img');
            for (const img of nestedImages) {
                if (img.src && img.src.startsWith('http')) {
                    return img.src;
                }
            }
        }
    }

    // 4. data属性をチェック
    const thumbnailAttrs = ['data-thumbnail', 'data-poster', 'data-preview', 'data-image'];
    for (const attr of thumbnailAttrs) {
        const value = video.getAttribute(attr);
        if (value && value.startsWith('http')) {
            return value;
        }
    }

    return null;
}

/**
 * リンク要素の周辺からサムネイル画像を検出
 * @param {HTMLAnchorElement} link - リンク要素
 * @returns {string|null} - サムネイル画像のURL、見つからない場合はnull
 */
function findLinkThumbnail(link) {
    // 1. リンク内の画像を検索
    const linkImages = link.querySelectorAll('img');
    for (const img of linkImages) {
        if (img.src && img.src.startsWith('http')) {
            return img.src;
        }
    }

    // 2. 親要素内の画像を検索
    let parent = link.parentElement;
    for (let i = 0; i < 3 && parent; i++) {
        const images = parent.querySelectorAll('img');
        for (const img of images) {
            if (img.src && img.src.startsWith('http')) {
                return img.src;
            }
        }
        parent = parent.parentElement;
    }

    // 3. 兄弟要素内の画像を検索
    if (link.parentElement) {
        const siblings = Array.from(link.parentElement.children);
        for (const sibling of siblings) {
            if (sibling !== link) {
                if (sibling.tagName === 'IMG' && sibling.src) {
                    return sibling.src;
                }
                const nestedImages = sibling.querySelectorAll('img');
                for (const img of nestedImages) {
                    if (img.src && img.src.startsWith('http')) {
                        return img.src;
                    }
                }
            }
        }
    }

    // 4. data属性をチェック
    const thumbnailAttrs = ['data-thumbnail', 'data-poster', 'data-preview', 'data-image'];
    for (const attr of thumbnailAttrs) {
        const value = link.getAttribute(attr);
        if (value && value.startsWith('http')) {
            return value;
        }
    }

    return null;
}
