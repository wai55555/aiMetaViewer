/**
 * ページ内の全画像をスキャンし、AI画像を特定してモーダルを表示
 */
/**
 * ページ内の全画像をスキャンし、AI画像を特定してモーダルを表示
 */
async function scanAllImages() {
    console.log('[AI Meta Viewer] Starting full page scan...');

    const images = Array.from(document.querySelectorAll('img'));
    const totalImages = images.length;
    let processedCount = 0;
    let foundCount = 0;
    let isCancelled = false;

    // ユーザーに状況を伝えるオーバーレイ
    const overlayData = showScanningOverlay(totalImages);
    const { overlay, updateProgress, cancelButton } = overlayData;

    // キャンセルボタンのリスナー
    cancelButton.onclick = () => {
        isCancelled = true;
        overlay.remove();
        console.log('[AI Meta Viewer] Scan cancelled by user.');
    };

    try {
        const candidates = [];
        const scanPromises = [];

        for (const img of images) {
            if (isCancelled) break;

            // すでに content.js で解析済みのものをチェック
            if (typeof processedImages !== 'undefined' && processedImages.has(img)) {
                const data = processedImages.get(img);
                if (data && data.badge) {
                    candidates.push({
                        url: data.badge._originalUrl || img.src,
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

            // 未解析の画像について、オリジナルURL候補を解決
            const urls = resolveOriginalUrls(img);
            if (urls) {
                const urlArray = Array.isArray(urls) ? urls : [urls];

                // 各候補についてメタデータ取得を試行
                scanPromises.push((async () => {
                    let successfullyFoundMetadata = false;
                    let bestUrl = urlArray[0];

                    for (const url of urlArray) {
                        if (isCancelled) break;
                        try {
                            const response = await chrome.runtime.sendMessage({
                                action: 'fetchImageMetadata',
                                imageUrl: url
                            });

                            if (response && response.success && response.metadata && Object.keys(response.metadata).length > 0) {
                                candidates.push({
                                    url: url,
                                    filename: getFilenameFromUrl(url),
                                    metadata: response.metadata,
                                    isAI: true
                                });
                                foundCount++;
                                successfullyFoundMetadata = true;
                                break; // メタデータが見つかれば確定
                            }
                        } catch (e) {
                            console.error('[AI Meta Viewer] Error scanning URL:', url, e);
                        }
                    }

                    // メタデータが見つからなかった場合でも、アダプターで解決できた最初のURLは追加する
                    if (!successfullyFoundMetadata && !isCancelled) {
                        candidates.push({
                            url: bestUrl,
                            filename: getFilenameFromUrl(bestUrl),
                            metadata: null,
                            isAI: false
                        });
                    }

                    processedCount++;
                    if (!isCancelled) updateProgress(processedCount, foundCount);
                })());
            } else {
                // アダプターで解決できない画像もカウント
                processedCount++;
                updateProgress(processedCount, foundCount);
            }
        }

        // 全ての非同期解析を待機
        if (scanPromises.length > 0) {
            await Promise.all(scanPromises);
        }

        if (isCancelled) return;

        console.log('[AI Meta Viewer] Scan complete. Found images:', candidates.length, 'AI:', foundCount);

        if (candidates.length > 0) {
            // ダウンロードに必要な文脈情報を渡す
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
        // オーバーレイを削除
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
        box-shadow: 0 8px 32px rgba(0,0,0,0.6);
        border: 1px solid rgba(255,255,255,0.1);
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
