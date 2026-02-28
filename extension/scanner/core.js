/**
 * scanner/core.js - Scan Logic & Data Processing (Model Layer)
 * 
 * 責務: ビジネスロジックの集約
 * - 画像収集とフィルタリング
 * - メタデータ取得（バッチ処理）
 * - キャッシュ管理
 * - DOM操作は行わない（純粋なデータ処理のみ）
 */

// ネガティブキャッシュ（メタデータが無かったURLを記憶）
const noMetadataCache = new Set();
// ポジティブキャッシュ
const localMetadataCache = new Map();

/**
 * @typedef {Object} ScanResult
 * @property {Array} candidates - 検出されたメディア候補
 * @property {number} totalImages - スキャン対象の総画像数
 * @property {number} foundCount - AI判定された数
 * @property {number} uniqueFetchCount - 実行されたフェッチ数
 */

/**
 * ページ内の画像を収集・フィルタリングする
 * @param {Object} settings - ユーザー設定
 * @returns {Array} フィルタリング済みの画像要素配列
 */
function collectAndFilterImages(settings) {
    const allImages = Array.from(document.querySelectorAll('img'));
    let filteredCount = 0;

    const images = allImages.filter(img => {
        // アダプターで解決を試みる
        const resolved = typeof resolveOriginalUrls === 'function' ? resolveOriginalUrls(img) : null;
        const resolvedUrls = Array.isArray(resolved) ? resolved : (resolved ? [resolved] : []);

        // オリジナルの「別のURL」が見つかった場合は、サムネイルの可能性が高いので許可
        const hasNewResolution = resolvedUrls.some(u => u !== img.src && u !== img.currentSrc);
        if (hasNewResolution) return true;

        const width = img.naturalWidth || img.width || 0;
        const height = img.naturalHeight || img.height || 0;

        // サイズが0の場合は、まだロードされていないか隠れている可能性があるため、
        // 念のためスキャン対象に含める
        if (width === 0 || height === 0) return true;

        // 数値として比較することを保証
        const minPixels = Number(settings.minPixelCount) || 0;
        const minSize = Number(settings.minImageSize) || 0;

        // 最小画素数チェック
        if (width * height < minPixels) {
            filteredCount++;
            return false;
        }

        // 最小サイズチェック
        if (width < minSize || height < minSize) {
            filteredCount++;
            return false;
        }

        return true;
    });

    debugLog(`[AI Meta Viewer] Found ${allImages.length} images, ${images.length} kept, ${filteredCount} filtered out by size settings.`);

    return images;
}

/**
 * 画像をビューポート内の表示順でソート
 * @param {Array} images - 画像要素配列
 * @returns {Array} ソート済み配列
 */
function sortImagesByViewport(images) {
    const viewportHeight = window.innerHeight;
    return images.sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();

        const visibleA = rectA.top < viewportHeight && rectA.bottom > 0;
        const visibleB = rectB.top < viewportHeight && rectB.bottom > 0;

        if (visibleA && !visibleB) return -1;
        if (!visibleA && visibleB) return 1;

        return rectA.top - rectB.top;
    });
}

/**
 * URLをグループ化して重複を排除
 * @param {Array} images - 画像要素配列
 * @returns {Object} { urlToImagesMap, skippedImages }
 */
function groupImagesByUrl(images) {
    const urlToImagesMap = new Map();
    const skippedImages = new Set();

    for (const img of images) {
        // 既に処理済みの画像はスキップ
        if (typeof processedImages !== 'undefined' && processedImages.has(img)) {
            continue;
        }

        const urls = resolveOriginalUrls(img);
        if (urls) {
            const urlArray = Array.isArray(urls) ? urls : [urls];
            for (const url of urlArray) {
                if (!urlToImagesMap.has(url)) {
                    urlToImagesMap.set(url, []);
                }
                urlToImagesMap.get(url).push(img);
            }
        } else {
            // アダプターで解決できない場合、img.srcをフォールバック
            const src = img.src || img.currentSrc;
            if (src && src.startsWith('http')) {
                if (!urlToImagesMap.has(src)) {
                    urlToImagesMap.set(src, []);
                }
                urlToImagesMap.get(src).push(img);
            } else {
                skippedImages.add(img);
            }
        }
    }

    return { urlToImagesMap, skippedImages };
}

/**
 * フェッチ対象のURLをフィルタリング（キャッシュ確認）
 * @param {Array} uniqueUrls - ユニークなURL配列
 * @param {Map} urlToImagesMap - URL -> 画像配列のマップ
 * @returns {Object} { urlsToFetch, fetchResults }
 */
function filterUrlsByCache(uniqueUrls, urlToImagesMap) {
    const fetchResults = new Map();
    let processedCount = 0;
    let foundCount = 0;

    const urlsToFetch = uniqueUrls.filter(url => {
        const associatedImages = urlToImagesMap.get(url) || [];

        if (noMetadataCache.has(url)) {
            fetchResults.set(url, null);
            processedCount += associatedImages.length;
            return false;
        }

        if (localMetadataCache.has(url)) {
            const meta = localMetadataCache.get(url);
            fetchResults.set(url, meta);
            processedCount += associatedImages.length;
            if (meta && Object.keys(meta).length > 0) {
                foundCount += associatedImages.length;
            }
            return false;
        }

        return true;
    });

    return { urlsToFetch, fetchResults, processedCount, foundCount };
}

/**
 * バッチ処理でメタデータをフェッチ
 * @param {Array} urlsToFetch - フェッチ対象のURL配列
 * @param {Map} urlToImagesMap - URL -> 画像配列のマップ
 * @param {Function} onProgress - 進捗コールバック
 * @param {Function} isCancelled - キャンセル判定関数
 * @returns {Promise<Object>} { fetchResults, processedCount, foundCount }
 */
async function fetchMetadataBatch(urlsToFetch, urlToImagesMap, onProgress, isCancelled) {
    const CONCURRENCY_LIMIT = 8;
    const fetchResults = new Map();
    let processedCount = 0;
    let foundCount = 0;
    let uniqueFetchCount = 0;

    const queue = [...urlsToFetch];

    async function worker() {
        while (queue.length > 0 && !isCancelled()) {
            const url = queue.shift();
            uniqueFetchCount++;

            try {
                const response = await chrome.runtime.sendMessage({
                    action: 'fetchImageMetadata',
                    imageUrl: url
                });

                if (response && response.success && response.metadata && Object.keys(response.metadata).length > 0) {
                    localMetadataCache.set(url, response.metadata);
                    fetchResults.set(url, response.metadata);
                } else {
                    noMetadataCache.add(url);
                    fetchResults.set(url, null);
                }
            } catch (e) {
                console.error('[AI Meta Viewer] Error fetching URL:', url, e);
                noMetadataCache.add(url);
                fetchResults.set(url, null);
            }

            // プログレス更新
            const relatedImages = urlToImagesMap.get(url) || [];
            processedCount += relatedImages.length;

            const resMeta = fetchResults.get(url);
            if (resMeta && Object.keys(resMeta).length > 0) {
                foundCount += relatedImages.length;
            }

            onProgress(processedCount, foundCount);
        }
    }

    const workers = Array(Math.min(CONCURRENCY_LIMIT, queue.length))
        .fill(null)
        .map(() => worker());

    await Promise.all(workers);

    return { fetchResults, processedCount, foundCount, uniqueFetchCount };
}

/**
 * フェッチ結果から候補リストを生成
 * @param {Array} images - 画像要素配列
 * @param {Map} fetchResults - フェッチ結果マップ
 * @param {Map} urlToImagesMap - URL -> 画像配列のマップ
 * @returns {Array} 候補オブジェクト配列
 */
function buildCandidatesFromResults(images, fetchResults, urlToImagesMap) {
    const candidates = [];
    const candidateUrls = new Set();

    for (const img of images) {
        const urls = resolveOriginalUrls(img);
        const urlArray = (Array.isArray(urls) ? urls : [urls]).filter(u => typeof u === 'string' && u.length > 0);

        if (urlArray.length === 0) continue; // 有効なURLがない場合はスキップ

        let bestMetadata = null;
        let bestUrl = urlArray[0];

        for (const url of urlArray) {
            const res = fetchResults.get(url);
            if (res) {
                bestMetadata = res;
                bestUrl = url;
                break;
            }
        }

        if (bestMetadata) {
            if (!candidateUrls.has(bestUrl)) {
                candidates.push({
                    type: 'image',
                    url: bestUrl,
                    thumbnailUrl: img.src,
                    filename: getFilenameFromUrl(bestUrl),
                    metadata: bestMetadata,
                    width: img.naturalWidth || img.width || 0,
                    height: img.naturalHeight || img.height || 0,
                    isAI: true
                });
                candidateUrls.add(bestUrl);
            }
        } else {
            if (!candidateUrls.has(bestUrl)) {
                candidates.push({
                    type: 'image',
                    url: bestUrl,
                    thumbnailUrl: img.src,
                    filename: getFilenameFromUrl(bestUrl),
                    metadata: null,
                    width: img.naturalWidth || img.width || 0,
                    height: img.naturalHeight || img.height || 0,
                    isAI: false
                });
                candidateUrls.add(bestUrl);
            }
        }
    }

    return { candidates, candidateUrls };
}

/**
 * ディープスキャン（SiteAdapters経由）
 * @param {Set} candidateUrls - 既に追加されたURL集合
 * @returns {Array} 追加の候補オブジェクト配列
 */
function performDeepScan(candidateUrls) {
    const deepCandidates = [];

    if (typeof SiteAdapters === 'undefined') {
        return deepCandidates;
    }

    for (const adapter of SiteAdapters) {
        if (adapter.match() && typeof adapter.deepScan === 'function') {
            const results = adapter.deepScan(document);
            if (results && Array.isArray(results)) {
                debugLog(`[AI Meta Viewer] Deep scan found ${results.length} candidates`);
                for (const dc of results) {
                    if (!candidateUrls.has(dc.url)) {
                        deepCandidates.push({
                            type: dc.type || 'image',
                            url: dc.url,
                            thumbnailUrl: dc.thumbnailUrl || null,
                            filename: dc.filename || getFilenameFromUrl(dc.url),
                            metadata: dc.metadata || null,
                            isAI: dc.isAI !== undefined ? dc.isAI : false,
                            autoSelect: dc.autoSelect,
                            isCivitaiModel: dc.isCivitaiModel,
                            modelName: dc.modelName,
                            width: dc.width || 0,
                            height: dc.height || 0
                        });
                        candidateUrls.add(dc.url);
                    }
                }
            }
        }
    }

    return deepCandidates;
}

/**
 * 画像以外のメディア要素（video, audio, 特定の拡張子を持つリンク）を収集
 * @param {Set} candidateUrls - 既に収集したURLのSet (重複防止用)
 * @returns {Array} 検出された追加のメディア候補
 */
function collectOtherMedia(candidateUrls) {
    const otherCandidates = [];

    debugLog('[AI Meta Viewer] Scanning for other media types...');

    // 1. 動画要素の検出
    const videos = Array.from(document.querySelectorAll('video'));
    for (const video of videos) {
        const src = video.src || video.currentSrc;
        if (!src) continue;

        if (candidateUrls.has(src)) continue;

        let thumbnailUrl = video.poster || null;
        if (!thumbnailUrl && typeof findVideoThumbnail === 'function') {
            thumbnailUrl = findVideoThumbnail(video);
        }

        otherCandidates.push({
            type: 'video',
            url: src,
            thumbnailUrl: thumbnailUrl,
            filename: typeof getFilenameFromUrl === 'function' ? getFilenameFromUrl(src) : 'video.mp4',
            metadata: null,
            isAI: false
        });
        candidateUrls.add(src);
    }

    // 2. 音声要素の検出
    const audios = Array.from(document.querySelectorAll('audio'));
    for (const audio of audios) {
        const src = audio.src || audio.currentSrc;
        if (!src) continue;

        if (candidateUrls.has(src)) continue;

        otherCandidates.push({
            type: 'audio',
            url: src,
            thumbnailUrl: null,
            filename: typeof getFilenameFromUrl === 'function' ? getFilenameFromUrl(src) : 'audio.mp3',
            metadata: null,
            isAI: false
        });
        candidateUrls.add(src);
    }

    // 3. リンクからのメディア検出
    const links = Array.from(document.querySelectorAll('a[href]'));
    const mediaLinks = links.filter(a => {
        const href = a.href.toLowerCase();
        return /\.(mp4|webm|mkv|avi|flv|mov|mp3|wav|ogg|m4a|flac|zip|rar|7z|lzh|tar|tar\.gz|tar\.bz2|tar\.xz|tgz|tbz2|safetensors|ckpt|pt)$/i.test(href);
    });

    for (const link of mediaLinks) {
        const href = link.href;

        if (candidateUrls.has(href)) continue;

        const filename = typeof getFilenameFromUrl === 'function' ? getFilenameFromUrl(href) : 'file';
        const type = typeof getMediaType === 'function' ? getMediaType(filename) : 'unknown';

        let thumbnailUrl = null;
        if (type === 'video' && typeof findLinkThumbnail === 'function') {
            thumbnailUrl = findLinkThumbnail(link);
        }

        otherCandidates.push({
            type: type !== 'unknown' ? type : 'archive', // フォールバックは一応archive扱いに
            url: href,
            thumbnailUrl: thumbnailUrl,
            filename: filename,
            metadata: null,
            isAI: false // デフォルトはfalse (safetensors等は後にディープスキャンで解決される可能性もある)
        });
        candidateUrls.add(href);
    }

    return otherCandidates;
}

/**
 * メモリキャッシュをクリア
 * @returns {Object} クリア統計
 */
function clearMemoryCaches() {
    const noMetadataCacheSize = noMetadataCache.size;
    const localMetadataCacheSize = localMetadataCache.size;

    noMetadataCache.clear();
    localMetadataCache.clear();

    debugLog(`[AI Meta Viewer] Scanner caches cleared: noMetadataCache=${noMetadataCacheSize}, localMetadataCache=${localMetadataCacheSize}`);

    return {
        noMetadataCache: noMetadataCacheSize,
        localMetadataCache: localMetadataCacheSize
    };
}
