// scanner/progress-ui.js - プログレス表示・通知UI

/**
 * 自動的に消える通知を表示
 * @param {string} message - 表示するメッセージ
 * @param {number} duration - 表示時間(ミリ秒)、デフォルト3秒
 */
function showNotification(message, duration = 3000) {
    const notification = document.createElement('div');
    notification.style.cssText = `
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
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
        border: 1px solid rgba(255, 255, 255, 0.1);
        backdrop-filter: blur(8px);
        min-width: 240px;
        text-align: center;
        animation: ai-meta-fade-in 0.3s ease-out;
    `;
    notification.textContent = message;

    document.body.appendChild(notification);

    // フェードアウトアニメーション後に削除
    setTimeout(() => {
        notification.style.animation = 'ai-meta-fade-out 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
    }, duration);
}

/**
 * スキャン中のオーバーレイを表示
 * セキュリティ: innerHTML を使わず、createElement で安全に構築
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

    // Header row
    const headerRow = document.createElement('div');
    headerRow.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 15px;';

    const headerLeft = document.createElement('div');
    headerLeft.style.cssText = 'display: flex; align-items: center; gap: 10px;';

    const spinner = document.createElement('div');
    spinner.style.cssText = 'width: 16px; height: 16px; border: 2px solid rgba(255,255,255,0.2); border-top-color: #4CAF50; border-radius: 50%; animation: ai-meta-spin 0.8s linear infinite;';

    const label = document.createElement('span');
    label.textContent = 'Scanning AI Images';
    label.style.cssText = 'font-weight: 600; letter-spacing: 0.3px;';

    headerLeft.appendChild(spinner);
    headerLeft.appendChild(label);

    const cancelButton = document.createElement('button');
    cancelButton.id = 'ai-meta-scan-cancel';
    cancelButton.textContent = 'Cancel';
    cancelButton.style.cssText = 'background: rgba(255,255,255,0.1); border: none; color: #ffab91; font-size: 11px; padding: 4px 8px; border-radius: 4px; cursor: pointer; transition: background 0.2s;';

    cancelButton.addEventListener('mouseover', () => {
        cancelButton.style.background = 'rgba(255,255,255,0.2)';
    });
    cancelButton.addEventListener('mouseout', () => {
        cancelButton.style.background = 'rgba(255,255,255,0.1)';
    });

    headerRow.appendChild(headerLeft);
    headerRow.appendChild(cancelButton);

    // Progress bar container
    const progressContainer = document.createElement('div');
    progressContainer.style.cssText = 'height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden;';

    const progressBar = document.createElement('div');
    progressBar.id = 'ai-meta-scan-progress-bar';
    progressBar.style.cssText = 'width: 0%; height: 100%; background: #4CAF50; transition: width 0.3s ease;';

    progressContainer.appendChild(progressBar);

    // Stats row
    const statsRow = document.createElement('div');
    statsRow.style.cssText = 'display: flex; justify-content: space-between; font-size: 12px; color: #aaa;';

    const countText = document.createElement('span');
    countText.id = 'ai-meta-scan-count';
    countText.textContent = `Progress: 0 / ${total}`;

    const foundText = document.createElement('span');
    foundText.id = 'ai-meta-scan-found';
    foundText.textContent = 'Found: 0';
    foundText.style.cssText = 'color: #81C784;';

    statsRow.appendChild(countText);
    statsRow.appendChild(foundText);

    // Assemble overlay
    overlay.appendChild(headerRow);
    overlay.appendChild(progressContainer);
    overlay.appendChild(statsRow);

    const updateProgress = (current, found) => {
        // Division by zero ガード
        if (total <= 0) {
            progressBar.style.width = '0%';
            countText.textContent = `Progress: 0 / 0`;
            foundText.textContent = `Found: ${found}`;
            return;
        }

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
            @keyframes ai-meta-fade-in {
                from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
                to { opacity: 1; transform: translateX(-50%) translateY(0); }
            }
            @keyframes ai-meta-fade-out {
                from { opacity: 1; transform: translateX(-50%) translateY(0); }
                to { opacity: 0; transform: translateX(-50%) translateY(-10px); }
            }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(overlay);
    return { overlay, updateProgress, cancelButton };
}
