// scanner.js - Phase 2 Optimized: Deduplication, Negative Caching, Batch Processing

// ネガティブキャッシュ（メタデータが無かったURLを記憶）
const noMetadataCache = new Set();
// ポジティブキャッシュは content.js の metadataCache を使用（グローバルではないため、ここでも持つか、メッセージ経由にする）
// content.jsのmetadataCacheはexportされていないので、scanner.js内でもキャッシュを持つ必要がある。
// ただし、processedImagesにあるものは既にチェック済みなのでスキップされる。
const localMetadataCache = new Map();

async function scanAllImages() {
    console.log('[AI Meta Viewer] Starting optimized full page scan (Phase 2)...');

    // 1. 画像収集と優先順位付け
    const images = Array.from(document.querySelectorAll('img'));
    const totalImages = images.length;

    const viewportHeight = window.innerHeight;
    images.sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();

        const visibleA = rectA.top < viewportHeight && rectB.bottom > 0;
        const visibleB = rectB.top < viewportHeight && rectB.bottom > 0;

        if (visibleA && !visibleB) return -1;
        if (!visibleA && visibleB) return 1;

        return rectA.top - rectB.top;
    });

    let processedCount = 0;
    let foundCount = 0;
    let isCancelled = false;
    let uniqueFetchCount = 0;

    const overlayData = showScanningOverlay(totalImages);
    const { overlay, updateProgress, cancelButton } = overlayData;

    cancelButton.onclick = () => {
        isCancelled = true;
        overlay.remove();
        console.log('[AI Meta Viewer] Scan cancelled by user.');
    };

    try {
        const candidates = [];

        // 2. URL解決とグループ化
        // Map<OriginalURL, Array<HTMLImageElement>>
        const urlToImagesMap = new Map();
        // Set<HTMLImageElement> (URL解決に失敗したか、スキップ対象の画像)
        const skippedImages = new Set();

        for (const img of images) {
            // 既に処理済みの画像はスキップ
            if (typeof processedImages !== 'undefined' && processedImages.has(img)) {
                const data = processedImages.get(img);
                if (data && data.badge) {
                    candidates.push({
                        url: data.badge._originalUrl || img.src,
                        thumbnailUrl: img.src, // Use current image src as thumbnail
                        filename: getFilenameFromUrl(data.badge._originalUrl || img.src),
                        metadata: data.badge._metadata || null,
                        isAI: !!(data.badge._metadata && Object.keys(data.badge._metadata).length > 0)
                    });
                    processedCount++;
                    if (candidates[candidates.length - 1].isAI) foundCount++;
                    updateProgress(processedCount, foundCount);
                    continue;
                }
            }

            const urls = resolveOriginalUrls(img);
            if (urls) {
                // 複数の候補がある場合、全てを試す必要があるが、
                // ここでは単純化のため、配列の場合は主要なURLだけをキーにするか、
                // 構成を工夫する。resolveOriginalUrlsは配列を返すことがある。
                const urlArray = Array.isArray(urls) ? urls : [urls];

                // 画像ごとにどのURLを試すべきかを保持
                // URL単位でフェッチするため、逆引きマップを作る
                for (const url of urlArray) {
                    if (!urlToImagesMap.has(url)) {
                        urlToImagesMap.set(url, []);
                    }
                    urlToImagesMap.get(url).push(img);
                }
            } else {
                skippedImages.add(img);
                processedCount++;
                updateProgress(processedCount, foundCount);
            }
        }

        // 3. フェッチ対象のユニークURLリストを作成
        const uniqueUrls = Array.from(urlToImagesMap.keys());

        // キャッシュチェック済みの結果を格納するマップ
        const fetchResults = new Map(); // URL -> Metadata | null

        const urlsToFetch = uniqueUrls.filter(url => {
            const associatedImages = urlToImagesMap.get(url) || [];
            if (noMetadataCache.has(url)) {
                fetchResults.set(url, null);
                // ネガティブキャッシュヒット: 進捗更新
                processedCount += associatedImages.length;
                updateProgress(processedCount, foundCount);
                return false;
            }
            if (localMetadataCache.has(url)) {
                const meta = localMetadataCache.get(url);
                fetchResults.set(url, meta);
                // ポジティブキャッシュヒット: 進捗更新
                processedCount += associatedImages.length;
                if (meta && Object.keys(meta).length > 0) {
                    foundCount += associatedImages.length;
                }
                updateProgress(processedCount, foundCount);
                return false;
            }
            return true;
        });

        console.log(`[AI Meta Viewer] Unique URLs to fetch: ${urlsToFetch.length} (Total images: ${images.length})`);

        // 4. バッチ処理でフェッチ実行
        const CONCURRENCY_LIMIT = 8; // 重複排除したので少し増やす

        const queue = [...urlsToFetch];

        async function worker() {
            while (queue.length > 0 && !isCancelled) {
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
                    noMetadataCache.add(url); // エラーの場合も一旦記録しておく
                    fetchResults.set(url, null);
                }

                // プログレス更新 (Batch Processing)
                const relatedImages = urlToImagesMap.get(url) || [];
                processedCount += relatedImages.length;

                // メタデータが見つかった場合（またはキャッシュセットされた場合）、関連画像すべてが「AI判定」となる
                // ここでの判定は簡易的。正確にはレスポンスの中身を見る。
                const resMeta = fetchResults.get(url);
                if (resMeta && Object.keys(resMeta).length > 0) {
                    foundCount += relatedImages.length;
                }
                updateProgress(processedCount, foundCount);
            }
        }

        const workers = Array(Math.min(CONCURRENCY_LIMIT, queue.length))
            .fill(null)
            .map(() => worker());

        await Promise.all(workers);

        if (isCancelled) return;

        // 5. 結果の適用と候補リスト作成
        // 各画像について、自分に関連するURLの結果を確認して採用

        // スキップされた画像以外の処理対象画像
        const imagesToResolve = images.filter(img => !skippedImages.has(img) && !(typeof processedImages !== 'undefined' && processedImages.has(img)));

        for (const img of imagesToResolve) {
            const urls = resolveOriginalUrls(img);
            const urlArray = Array.isArray(urls) ? urls : [urls];

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
                candidates.push({
                    url: bestUrl,
                    thumbnailUrl: img.src, // Use current image src as thumbnail
                    filename: getFilenameFromUrl(bestUrl),
                    metadata: bestMetadata,
                    isAI: true
                });
                foundCount++;
            } else {
                // メタデータなし
                candidates.push({
                    url: bestUrl,
                    thumbnailUrl: img.src, // Use current image src as thumbnail
                    filename: getFilenameFromUrl(bestUrl),
                    metadata: null,
                    isAI: false
                });
            }

            // processedCount++; // Worker側でカウント済みのためここでは除去
            // updateProgress(processedCount, foundCount);
        }

        console.log('[AI Meta Viewer] Scan complete. Found images:', candidates.length, 'AI:', foundCount, 'Unique Fetches:', uniqueFetchCount);

        // 最終的な整合性のために一回更新
        updateProgress(totalImages, foundCount);

        if (candidates.length > 0) {
            const context = {
                pageTitle: document.title,
                domain: window.location.hostname
            };
            const modal = createDownloaderModal(candidates, context);
            document.body.appendChild(modal);
        } else {
            alert('No images suitable for download found on this page.');
        }

    } finally {
        if (overlay && overlay.parentNode) overlay.remove();
    }
}

/**
 * スキャン中のオーバーレイを表示
 */
function showScanningOverlay(total) {
    const overlay = document.createElement('div');
    overlay.className = 'ai-meta-scan-overlay';
    overlay.style.cssText = `
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background-color: rgba(30, 30, 30, 0.95);
        color: white;
        padding: 12px 20px;
        border-radius: 12px;
        z-index: 2147483647;
        font-family: 'Segoe UI', sans-serif;
        font-size: 14px;
        display: flex;
        flex-direction: column;
        gap: 8px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(8px);
        min-width: 240px;
    `;

    overlay.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 15px;">
            <div style="display: flex; align-items: center; gap: 10px;">
                <div style="width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.2); border-top-color: #4CAF50; border-radius: 50%; animation: ai-meta-spin 0.8s linear infinite;"></div>
                <span style="font-weight: 600; letter-spacing: 0.3px;">Scanning AI Images</span>
            </div>
            <button id="ai-meta-scan-cancel" style="background: rgba(255,255,255,0.1); border: none; color: #ffab91; font-size: 11px; padding: 4px 8px; border-radius: 4px; cursor: pointer; transition: background 0.2s;">Cancel</button>
        </div>
        <div style="height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;">
            <div id="ai-meta-scan-progress-bar" style="width: 0%; height: 100%; background: #4CAF50; transition: width 0.3s ease;"></div>
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 12px; color: #aaa;">
            <span id="ai-meta-scan-count">Progress: 0 / ${total}</span>
            <span id="ai-meta-scan-found" style="color: #81C784;">Found: 0</span>
        </div>
    `;

    // ホバーエフェクト
    const cancelButton = overlay.querySelector('#ai-meta-scan-cancel');
    cancelButton.onmouseover = () => cancelButton.style.background = 'rgba(255,255,255,0.2)';
    cancelButton.onmouseout = () => cancelButton.style.background = 'rgba(255,255,255,0.1)';

    const progressBar = overlay.querySelector('#ai-meta-scan-progress-bar');
    const countText = overlay.querySelector('#ai-meta-scan-count');
    const foundText = overlay.querySelector('#ai-meta-scan-found');

    const updateProgress = (current, found) => {
        const percent = Math.round((current / total) * 100);
        progressBar.style.width = `${percent}%`;
        countText.textContent = `Progress: ${current} / ${total}`;
        foundText.textContent = `Found: ${found}`;
    };

    // アニメーション用のスタイルを追加（初回のみ）
    if (!document.getElementById('ai-meta-scan-styles')) {
        const style = document.createElement('style');
        style.id = 'ai-meta-scan-styles';
        style.textContent = `
            @keyframes ai-meta-spin {
                to { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(overlay);
    return { overlay, updateProgress, cancelButton };
}

/**
 * URLからファイル名を推測
 */
function getFilenameFromUrl(urlStr) {
    try {
        const url = new URL(urlStr);
        const path = url.pathname;
        const parts = path.split('/');
        const lastPart = parts[parts.length - 1];
        if (lastPart && lastPart.includes('.')) {
            return lastPart;
        }
    } catch (e) { }
    return `image_${Date.now()}.png`;
}

/**
 * アダプターを使用してオリジナルURLを解決
 * content.js の SiteAdapters のロジックを流用（グローバル参照可能な想定）
 */
function resolveOriginalUrls(img) {
    if (typeof SiteAdapters === 'undefined') return null;

    for (const adapter of SiteAdapters) {
        if (adapter.match()) {
            return adapter.resolve(img);
        }
    }
    return null;
}

// Backgroundからのトリガー待機
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'triggerScan') {
        scanAllImages();
        sendResponse({ success: true });
    }
});

/**
 * ダウンロード用モーダルを作成
 */
function createDownloaderModal(candidates, context) {
    const modalOverlay = document.createElement('div');
    modalOverlay.id = 'ai-meta-downloader-overlay';
    modalOverlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(4px);
        z-index: 2147483647;
        display: flex;
        justify-content: center;
        align-items: center;
        font-family: 'Segoe UI', system-ui, sans-serif;
    `;

    // 候補リストから初期選択状態（AI画像のみデフォルトONなど）
    // candidates: [{ url, filename, metadata, isAI }]
    let selectedUrls = new Set(candidates.filter(c => c.isAI).map(c => c.url));

    const container = document.createElement('div');
    container.style.cssText = `
        background: #1e1e1e;
        color: #eee;
        width: 800px;
        max-width: 90vw;
        height: 80vh;
        border-radius: 12px;
        box-shadow: 0 20px 50px rgba(0,0,0,0.5);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid rgba(255,255,255,0.1);
    `;

    // --- Header ---
    const header = document.createElement('div');
    header.style.cssText = `
        padding: 16px 24px;
        background: #252525;
        border-bottom: 1px solid #333;
        display: flex;
        justify-content: space-between;
        align-items: center;
    `;
    header.innerHTML = `
        <div>
            <h2 style="margin: 0; font-size: 18px; font-weight: 600;">Found Images</h2>
            <div style="font-size: 12px; color: #aaa; margin-top: 4px;">${context.pageTitle || 'Unknown Page'}</div>
        </div>
        <div style="display: flex; items-align: center; gap: 15px;">
            <div style="text-align: right;">
                <div style="font-size: 12px; color: #aaa;">Total: ${candidates.length}</div>
                <div style="font-size: 12px; color: #4CAF50;">AI Detected: ${candidates.filter(c => c.isAI).length}</div>
            </div>
            <button id="ai-meta-close-btn" style="background: none; border: none; color: #aaa; cursor: pointer; font-size: 24px; padding: 0 8px;">&times;</button>
        </div>
    `;

    // --- Content (Grid) ---
    const content = document.createElement('div');
    content.style.cssText = `
        flex: 1;
        overflow-y: auto;
        padding: 20px;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
        gap: 16px;
        background: #1a1a1a;
    `;

    // 画像アイテム生成
    function renderItems() {
        content.innerHTML = '';
        candidates.forEach(c => {
            const isSelected = selectedUrls.has(c.url);
            const item = document.createElement('div');
            item.style.cssText = `
                position: relative;
                border-radius: 8px;
                overflow: hidden;
                background: #2a2a2a;
                border: 2px solid ${isSelected ? '#4CAF50' : 'transparent'};
                cursor: pointer;
                transition: transform 0.1s, border-color 0.1s;
                height: 180px;
                display: flex;
                flex-direction: column;
            `;
            item.onclick = (e) => {
                // チェックボックスクリック時は伝播しない
                if (e.target.tagName === 'INPUT') return;
                toggleSelection(c.url);
            };

            const imgContainer = document.createElement('div');
            imgContainer.style.cssText = `
                flex: 1;
                background: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+PHJlY3Qgd2lkdGg9IjUiIGhlaWdodD0iNSIgZmlsbD0iIzMzMyIgLz48cmVjdCB4PSI1IiB5PSI1IiB3aWR0aD0iNSIgaGVpZ2h0PSI1IiBmaWxsPSIjMzMzIiAvPjwvc3ZnPg==');
                position: relative;
                overflow: hidden;
            `;

            // Image
            const img = document.createElement('img');
            img.src = c.thumbnailUrl || c.url; // Use thumbnail if available
            img.style.cssText = `
                width: 100%;
                height: 100%;
                object-fit: contain;
                display: block;
            `;
            imgContainer.appendChild(img);

            // Badges
            if (c.isAI) {
                const badge = document.createElement('span');
                badge.innerText = 'AI';
                badge.style.cssText = `
                    position: absolute;
                    top: 6px;
                    left: 6px;
                    background: #4CAF50;
                    color: white;
                    font-size: 10px;
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-weight: bold;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.5);
                `;
                imgContainer.appendChild(badge);
            }

            // Info
            const info = document.createElement('div');
            info.style.cssText = `
                padding: 8px;
                font-size: 11px;
                background: #252525;
                color: #ccc;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            `;
            info.innerText = c.filename;
            info.title = c.filename;

            // Checkbox overlay
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = isSelected;
            checkbox.style.cssText = `
                position: absolute;
                top: 8px;
                right: 8px;
                width: 16px;
                height: 16px;
                accent-color: #4CAF50;
                cursor: pointer;
            `;
            checkbox.onchange = () => toggleSelection(c.url);

            item.appendChild(imgContainer);
            item.appendChild(info);
            item.appendChild(checkbox);
            content.appendChild(item);
        });
    }

    function toggleSelection(url) {
        if (selectedUrls.has(url)) {
            selectedUrls.delete(url);
        } else {
            selectedUrls.add(url);
        }
        updateFooter();
        renderItems();
    }

    // --- Footer ---
    const footer = document.createElement('div');
    footer.style.cssText = `
        padding: 16px 24px;
        background: #252525;
        border-top: 1px solid #333;
        display: flex;
        justify-content: space-between;
        align-items: center;
    `;

    const leftControls = document.createElement('div');
    leftControls.style.display = 'flex';
    leftControls.style.gap = '10px';

    const btnStyle = `
        border: 1px solid #444;
        background: #333;
        color: #eee;
        padding: 6px 12px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 12px;
        transition: background 0.2s;
    `;

    const selectAllBtn = document.createElement('button');
    selectAllBtn.innerText = 'Select All';
    selectAllBtn.style.cssText = btnStyle;
    selectAllBtn.onclick = () => {
        selectedUrls = new Set(candidates.map(c => c.url));
        updateFooter();
        renderItems();
    };

    const selectAiBtn = document.createElement('button');
    selectAiBtn.innerText = 'Select AI Only';
    selectAiBtn.style.cssText = btnStyle;
    selectAiBtn.onclick = () => {
        selectedUrls = new Set(candidates.filter(c => c.isAI).map(c => c.url));
        updateFooter();
        renderItems();
    };

    const clearBtn = document.createElement('button');
    clearBtn.innerText = 'Clear';
    clearBtn.style.cssText = btnStyle;
    clearBtn.onclick = () => {
        selectedUrls.clear();
        updateFooter();
        renderItems();
    };

    leftControls.appendChild(selectAllBtn);
    leftControls.appendChild(selectAiBtn);
    leftControls.appendChild(clearBtn);

    const downloadBtn = document.createElement('button');
    downloadBtn.style.cssText = `
        background: #4CAF50;
        color: white;
        border: none;
        padding: 8px 24px;
        border-radius: 6px;
        font-weight: 600;
        cursor: pointer;
        font-size: 14px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.2);
    `;

    function updateFooter() {
        const count = selectedUrls.size;
        downloadBtn.innerText = `Download Selected (${count})`;
        downloadBtn.disabled = count === 0;
        downloadBtn.style.opacity = count === 0 ? '0.5' : '1';
        downloadBtn.style.cursor = count === 0 ? 'not-allowed' : 'pointer';
    }

    downloadBtn.onclick = async () => {
        const count = selectedUrls.size;
        if (count === 0) return;

        const targets = candidates.filter(c => selectedUrls.has(c.url)).map(c => ({
            url: c.url,
            filename: c.filename
        }));

        downloadBtn.innerText = 'Starting Download...';

        try {
            const res = await chrome.runtime.sendMessage({
                action: 'downloadImages',
                images: targets,
                context: {
                    pageTitle: context.pageTitle,
                    domain: context.domain
                }
            });

            if (res && res.success) {
                alert(`Started download for ${res.count} images.`);
                modalOverlay.remove();
            } else {
                alert('Download failed: ' + (res.error || 'Unknown error'));
                downloadBtn.innerText = `Download Selected (${count})`;
            }
        } catch (e) {
            console.error(e);
            alert('Failed to send download message.');
            downloadBtn.innerText = `Download Selected (${count})`;
        }
    };

    footer.appendChild(leftControls);
    footer.appendChild(downloadBtn);

    // Assemble
    container.appendChild(header);
    container.appendChild(content);
    container.appendChild(footer);
    modalOverlay.appendChild(container);

    // Initial Render
    renderItems();
    updateFooter();

    // Event Handlers
    modalOverlay.querySelector('#ai-meta-close-btn').onclick = () => modalOverlay.remove();
    modalOverlay.onclick = (e) => {
        if (e.target === modalOverlay) modalOverlay.remove();
    };

    return modalOverlay;
}
