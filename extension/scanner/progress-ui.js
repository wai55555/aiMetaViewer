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
