/**
 * scanner/ui.js - Modal UI Generation (View Layer)
 * 
 * 責務: ユーザーインターフェースの描画
 * - ダウンロードモーダルのDOM構築
 * - プログレス表示の更新
 * - 候補リストの描画
 * 
 * セキュリティ要件:
 * - ❌ innerHTML, outerHTML, document.write は禁止
 * - ✅ textContent, createElement, appendChild を使用
 */

/**
 * 安全なDOM要素生成ヘルパー
 * @param {string} tag - タグ名
 * @param {Object} attrs - 属性オブジェクト
 * @param {Array} children - 子要素配列
 * @returns {HTMLElement}
 */
function createElement(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);

    for (const [key, val] of Object.entries(attrs)) {
        if (key === 'text') {
            el.textContent = val;
        } else if (key === 'style' && typeof val === 'object') {
            Object.assign(el.style, val);
        } else if (key.startsWith('on')) {
            const eventName = key.substring(2).toLowerCase();
            el.addEventListener(eventName, val);
        } else if (key === 'class') {
            el.className = val;
        } else {
            el.setAttribute(key, val);
        }
    }

    children.forEach(child => {
        if (child) el.appendChild(child);
    });

    return el;
}

/**
 * ダウンロード用モーダルを作成
 * @param {Array} candidates - 検出されたメディア候補
 * @param {Object} context - ページコンテキスト { pageTitle, domain }
 * @returns {HTMLElement} モーダルオーバーレイ
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

    // 初期選択状態
    let selectedUrls = new Set();
    candidates.forEach(c => {
        if (c.type === 'archive') {
            if (c.autoSelect) {
                selectedUrls.add(c.url);
            }
        } else {
            if (c.autoSelect || (c.isAI && c.autoSelect !== false)) {
                selectedUrls.add(c.url);
            }
        }
    });

    const mediaSizes = new Map();

    // ファイルサイズの非同期取得
    candidates.forEach(c => {
        if (c.type !== 'image') {
            chrome.runtime.sendMessage({ action: 'getMediaSize', url: c.url }, (res) => {
                if (res && res.success && res.size) {
                    mediaSizes.set(c.url, res.size);
                    renderItems();
                    updateFooter();
                }
            });
        }
    });

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
        flex-direction: column;
        gap: 12px;
    `;

    // Title row
    const titleRow = document.createElement('div');
    titleRow.style.cssText = `
        display: flex;
        justify-content: space-between;
        align-items: center;
    `;

    const titleLeft = document.createElement('div');
    const titleH2 = document.createElement('h2');
    titleH2.textContent = 'Found Media';
    titleH2.style.cssText = 'margin: 0; font-size: 18px; font-weight: 600;';

    const titleSubtitle = document.createElement('div');
    titleSubtitle.id = 'ai-meta-scan-page-title';
    titleSubtitle.style.cssText = 'font-size: 12px; color: #aaa; margin-top: 4px;';
    titleSubtitle.textContent = context.pageTitle || 'Unknown Page';

    titleLeft.appendChild(titleH2);
    titleLeft.appendChild(titleSubtitle);

    const titleRight = document.createElement('div');
    titleRight.style.cssText = 'display: flex; items-align: center; gap: 15px;';

    const titleStats = document.createElement('div');
    titleStats.style.cssText = 'text-align: right;';

    const totalDiv = document.createElement('div');
    totalDiv.style.cssText = 'font-size: 12px; color: #aaa;';
    totalDiv.textContent = `Total: ${candidates.length}`;

    const aiDiv = document.createElement('div');
    aiDiv.style.cssText = 'font-size: 12px; color: #4CAF50;';
    aiDiv.textContent = `AI: ${candidates.filter(c => c.isAI).length}`;

    titleStats.appendChild(totalDiv);
    titleStats.appendChild(aiDiv);

    const closeBtn = document.createElement('button');
    closeBtn.id = 'ai-meta-close-btn';
    closeBtn.textContent = '×';
    closeBtn.style.cssText = `
        background: none;
        border: none;
        color: #aaa;
        cursor: pointer;
        font-size: 24px;
        padding: 0 8px;
    `;

    titleRight.appendChild(titleStats);
    titleRight.appendChild(closeBtn);
    titleRow.appendChild(titleLeft);
    titleRow.appendChild(titleRight);
    header.appendChild(titleRow);

    // Filter row
    const filterRow = document.createElement('div');
    filterRow.style.cssText = `
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
    `;

    const filterBtnStyle = {
        padding: '6px 12px',
        borderRadius: '6px',
        border: '1px solid #444',
        background: '#333',
        color: '#eee',
        cursor: 'pointer',
        fontSize: '12px',
        transition: 'all 0.2s'
    };

    const filterBtnActiveStyle = {
        padding: '6px 12px',
        borderRadius: '6px',
        border: '1px solid #4CAF50',
        background: '#4CAF50',
        color: 'white',
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: '600',
        transition: 'all 0.2s'
    };

    let activeFilter = 'all';

    const filterButtons = [
        { type: 'all', label: `All (${candidates.length})` },
        { type: 'image', label: `Images (${candidates.filter(c => c.type === 'image').length})` },
        { type: 'video', label: `Videos (${candidates.filter(c => c.type === 'video').length})` },
        { type: 'audio', label: `Audio (${candidates.filter(c => c.type === 'audio').length})` },
        { type: 'archive', label: `Archives (${candidates.filter(c => c.type === 'archive').length})` }
    ];

    filterButtons.forEach(({ type, label }) => {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.dataset.type = type;
        Object.assign(btn.style, type === 'all' ? filterBtnActiveStyle : filterBtnStyle);

        btn.addEventListener('click', () => {
            activeFilter = type;
            filterRow.querySelectorAll('button').forEach(b => {
                Object.assign(b.style, b.dataset.type === activeFilter ? filterBtnActiveStyle : filterBtnStyle);
            });
            renderItems();
        });

        filterRow.appendChild(btn);
    });

    header.appendChild(filterRow);

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

    // Render items
    function renderItems() {
        content.innerHTML = '';

        const filtered = activeFilter === 'all'
            ? candidates
            : candidates.filter(c => c.type === activeFilter);

        filtered.forEach(c => {
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

            item.addEventListener('click', (e) => {
                if (e.target.tagName === 'INPUT') return;
                toggleSelection(c.url);
            });

            const imgContainer = document.createElement('div');
            imgContainer.style.cssText = `
                flex: 1;
                background: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+PHJlY3Qgd2lkdGg9IjUiIGhlaWdodD0iNSIgZmlsbD0iIzMzMyIgLz48cmVjdCB4PSI1IiB5PSI1IiB3aWR0aD0iNSIgaGVpZ2h0PSI1IiBmaWxsPSIjMzMzIiAvPjwvc3ZnPg==');
                position: relative;
                overflow: hidden;
            `;

            // Image or Video Thumbnail
            if (c.type === 'video') {
                if (c.thumbnailUrl) {
                    const img = document.createElement('img');
                    img.src = c.thumbnailUrl;
                    img.style.cssText = `
                        width: 100%;
                        height: 100%;
                        object-fit: contain;
                        display: block;
                    `;
                    imgContainer.appendChild(img);
                } else {
                    const placeholder = document.createElement('div');
                    placeholder.style.cssText = `
                        width: 100%;
                        height: 100%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        background: #333;
                        color: #aaa;
                        font-size: 24px;
                    `;
                    placeholder.textContent = '🎬';
                    imgContainer.appendChild(placeholder);
                }
            } else {
                const img = document.createElement('img');
                img.src = c.thumbnailUrl || c.url;
                img.style.cssText = `
                    width: 100%;
                    height: 100%;
                    object-fit: contain;
                    display: block;
                `;

                if (c.type !== 'image') {
                    img.addEventListener('error', () => {
                        const placeholder = document.createElement('div');
                        placeholder.style.cssText = `
                            width: 100%;
                            height: 100%;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            background: #333;
                            color: #aaa;
                            font-size: 24px;
                        `;
                        const icons = {
                            audio: '🎵',
                            archive: '📦'
                        };
                        placeholder.textContent = icons[c.type] || '📄';
                        imgContainer.replaceChild(placeholder, img);
                    });
                }

                imgContainer.appendChild(img);
            }

            // Badges
            if (c.type !== 'image') {
                const typeBadge = document.createElement('span');
                const typeIcons = {
                    video: '🎬',
                    audio: '🎵',
                    archive: '📦'
                };
                typeBadge.textContent = typeIcons[c.type] || '📄';
                typeBadge.style.cssText = `
                    position: absolute;
                    top: 6px;
                    right: 6px;
                    background: rgba(0, 0, 0, 0.7);
                    color: white;
                    font-size: 16px;
                    padding: 4px;
                    border-radius: 4px;
                    line-height: 1;
                `;
                imgContainer.appendChild(typeBadge);
            }

            if (c.isAI) {
                const badge = document.createElement('span');
                badge.textContent = 'AI';
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
            info.textContent = c.filename;
            info.title = c.filename;

            if (mediaSizes.has(c.url)) {
                const size = mediaSizes.get(c.url);
                const sizeStr = formatBytes(size);
                const sizeBadge = document.createElement('div');
                sizeBadge.style.cssText = `
                    font-size: 10px;
                    color: #aaa;
                    margin-top: 2px;
                `;
                sizeBadge.textContent = sizeStr;
                info.appendChild(sizeBadge);
            }

            // Checkbox
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
            checkbox.addEventListener('change', () => toggleSelection(c.url));

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
    leftControls.style.cssText = 'display: flex; gap: 10px;';

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
    selectAllBtn.textContent = 'Select All';
    selectAllBtn.style.cssText = btnStyle;
    selectAllBtn.addEventListener('click', () => {
        candidates.forEach(c => selectedUrls.add(c.url));
        updateFooter();
        renderItems();
    });

    const selectAiBtn = document.createElement('button');
    selectAiBtn.textContent = 'Select AI Only';
    selectAiBtn.style.cssText = btnStyle;
    selectAiBtn.addEventListener('click', () => {
        selectedUrls.clear();
        candidates.forEach(c => {
            if (c.isAI) selectedUrls.add(c.url);
        });
        updateFooter();
        renderItems();
    });

    const clearBtn = document.createElement('button');
    clearBtn.textContent = 'Clear';
    clearBtn.style.cssText = btnStyle;
    clearBtn.addEventListener('click', () => {
        selectedUrls.clear();
        updateFooter();
        renderItems();
    });

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
        let totalSizeBytes = 0;
        selectedUrls.forEach(url => {
            totalSizeBytes += (mediaSizes.get(url) || 0);
        });

        const sizeStr = totalSizeBytes > 0 ? ` (${formatBytes(totalSizeBytes)})` : '';
        downloadBtn.textContent = `Download Selected (${count})${sizeStr}`;
        downloadBtn.disabled = count === 0;
        downloadBtn.style.opacity = count === 0 ? '0.5' : '1';
        downloadBtn.style.cursor = count === 0 ? 'not-allowed' : 'pointer';
    }

    downloadBtn.addEventListener('click', async () => {
        const count = selectedUrls.size;
        if (count === 0) return;

        let totalSizeBytes = 0;
        selectedUrls.forEach(url => {
            totalSizeBytes += (mediaSizes.get(url) || 0);
        });

        const ONE_GB = 1024 * 1024 * 1024;
        if (totalSizeBytes > ONE_GB) {
            const confirmed = confirm(`Selected items total ${formatBytes(totalSizeBytes)}, which exceeds 1GB.\nAre you sure you want to start downloading?`);
            if (!confirmed) return;
        }

        const targets = candidates.filter(c => selectedUrls.has(c.url));
        if (targets.length === 0) return;

        const civitaiModel = targets.find(t => t.isCivitaiModel);
        const downloadContext = {
            pageTitle: document.title,
            domain: window.location.hostname,
            url: window.location.href,
            isCivitai: !!civitaiModel,
            modelName: civitaiModel?.modelName || 'Civitai_Model'
        };

        downloadBtn.textContent = 'Downloading...';

        try {
            chrome.runtime.sendMessage({
                action: 'downloadImages',
                images: targets,
                context: downloadContext
            }, (response) => {
                if (response && response.success) {
                    showNotification(`Started download for ${response.count} items.`);
                    modalOverlay.remove();
                } else {
                    showNotification('Download failed: ' + (response?.error || 'Unknown error'));
                    updateFooter();
                }
            });
        } catch (e) {
            console.error(e);
            showNotification('Failed to send download message.');
            updateFooter();
        }
    });

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
    closeBtn.addEventListener('click', () => modalOverlay.remove());
    modalOverlay.addEventListener('click', (e) => {
        if (e.target === modalOverlay) modalOverlay.remove();
    });

    return modalOverlay;
}
