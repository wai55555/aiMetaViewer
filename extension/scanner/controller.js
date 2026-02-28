/**
 * scanner/controller.js - Event Handling & State Management (Controller Layer)
 * 
 * 責務: ユーザー入力とロジックの橋渡し
 * - イベントリスナーの登録
 * - UIからのイベントを受け取り、core.js のロジックを呼び出す
 * - 結果を ui.js に反映させる
 * - エラーハンドリングの境界（Error Boundary）
 */

/**
 * スキャンプロセスを実行
 * @param {Object} settings - ユーザー設定
 * @returns {Promise<Object>} { success, candidates, error }
 */
async function executeScan(settings, isCancelledFn = () => false) {
    try {
        debugLog('[AI Meta Viewer] Starting scan with settings:', settings);

        // 1. 画像収集とフィルタリング
        const images = collectAndFilterImages(settings);
        const totalImages = images.length;

        if (totalImages === 0) {
            return { success: false, error: 'No images found on this page', candidates: [] };
        }

        // 2. ビューポート順でソート
        sortImagesByViewport(images);

        // 3. URL解決とグループ化
        const { urlToImagesMap, skippedImages } = groupImagesByUrl(images);
        const uniqueUrls = Array.from(urlToImagesMap.keys());

        debugLog(`[AI Meta Viewer] Unique URLs: ${uniqueUrls.length}, Skipped: ${skippedImages.size}`);

        // 4. キャッシュフィルタリング
        const { urlsToFetch, fetchResults, processedCount, foundCount } = filterUrlsByCache(uniqueUrls, urlToImagesMap);

        let currentProcessed = processedCount;
        let currentFound = foundCount;

        // 5. メタデータフェッチ
        const onProgress = (processed, found) => {
            currentProcessed = processed;
            currentFound = found;
        };

        const batchResult = await fetchMetadataBatch(urlsToFetch, urlToImagesMap, onProgress, isCancelledFn);

        if (isCancelledFn()) {
            return { success: false, error: 'Scan cancelled by user', candidates: [] };
        }

        // Merge results
        for (const [url, metadata] of batchResult.fetchResults) {
            fetchResults.set(url, metadata);
        }

        // 6. 候補リスト生成
        const { candidates, candidateUrls } = buildCandidatesFromResults(images, fetchResults, urlToImagesMap);

        // 7. ディープスキャン
        const deepCandidates = performDeepScan(candidateUrls);

        // 8. その他のメディア (動画、音声、zip等) のスキャン
        const otherMedia = typeof collectOtherMedia === 'function' ? collectOtherMedia(candidateUrls) : [];

        const allCandidates = [...candidates, ...deepCandidates, ...otherMedia];

        debugLog(`[AI Meta Viewer] Scan complete: ${allCandidates.length} candidates found`);

        return {
            success: true,
            candidates: allCandidates,
            stats: {
                totalImages,
                uniqueUrls: uniqueUrls.length,
                fetchedUrls: batchResult.uniqueFetchCount,
                foundCount: currentFound
            }
        };
    } catch (error) {
        console.error('[AI Meta Viewer] Scan error:', error);
        return {
            success: false,
            error: error.message || 'Unknown error during scan',
            candidates: []
        };
    }
}

/**
 * スキャン結果をモーダルで表示
 * @param {Array} candidates - 検出されたメディア候補
 * @param {Object} context - ページコンテキスト
 */
function displayScanResults(candidates, context) {
    if (!candidates || candidates.length === 0) {
        showNotification('No AI-generated media found on this page.');
        return;
    }

    const modal = createDownloaderModal(candidates, context);
    document.body.appendChild(modal);
}

/**
 * キャンセル可能なスキャンを実行
 * @param {Object} settings - ユーザー設定
 * @returns {Object} { cancel, promise }
 */
function createCancellableScan(settings) {
    let isCancelled = false;

    const promise = (async () => {
        const result = await executeScan(settings);
        return result;
    })();

    return {
        cancel: () => {
            isCancelled = true;
        },
        promise
    };
}

/**
 * エラーハンドリングラッパー
 * @param {Function} fn - 実行する関数
 * @param {string} context - エラーコンテキスト
 * @returns {Promise<Object>} { success, data, error }
 */
async function safeExecute(fn, context = 'Operation') {
    try {
        const result = await fn();
        return { success: true, data: result };
    } catch (error) {
        console.error(`[AI Meta Viewer] ${context} failed:`, error);
        return {
            success: false,
            error: error.message || `${context} failed`,
            code: error.code || 'UNKNOWN_ERROR'
        };
    }
}
