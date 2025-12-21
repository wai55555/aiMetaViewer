// ui.js - UIコンポーネントモジュール

/**
 * バッジ要素を作成
 * @param {boolean} isLoading - 初期状態がローディングかどうか
 * @returns {HTMLElement} - バッジ要素
 */
function createBadge(isLoading = false) {
    const badge = document.createElement('div');
    badge.className = 'ai-meta-badge';

    if (isLoading) {
        badge.classList.add('loading');
        badge.textContent = 'Analyzing...';
        badge.title = 'Checking for image metadata...';
    } else {
        badge.textContent = 'View Metadata';
        badge.title = 'Click to view image metadata';
    }

    return badge;
}

/**
 * バッジの状態を更新
 * @param {HTMLElement} badge - 対象のバッジ要素
 * @param {Object|null} metadata - メタデータ（nullの場合はエラーまたはデータなし）
 * @param {boolean} isError - エラーかどうか
 */
function updateBadge(badge, metadata, isError = false) {
    badge.classList.remove('loading');

    if (isError) {
        // エラー時は通常非表示にするか、エラーアイコンにするが、
        // 今回の要件ではメタデータがない場合はバッジを削除するため、
        // ここでは明示的なエラー表示（赤色など）は行わない
        // 呼び出し元で remove() される想定
        return;
    }

    if (metadata) {
        badge.textContent = 'View Metadata';

        // ホバープレビュー用のツールチップ設定
        const generator = detectGenerator(metadata);
        let previewText = generator;

        // プロンプトの冒頭を追加
        const { positive } = parseMetadataToTabs(metadata);
        if (positive) {
            // 最初の50文字程度を表示
            const truncatedPrompt = positive.length > 50 ? positive.substring(0, 50) + '...' : positive;
            previewText += `\n${truncatedPrompt}`;
        }

        badge.setAttribute('data-tooltip', previewText);
        badge.title = ''; // title属性はツールチップと競合するので削除
    }
}

/**
 * エラー通知を表示（設定で有効な場合のみ）
 * @param {string} message - エラーメッセージ
 */
function showErrorNotification(message) {
    if (!document.body) return;

    // 設定で無効な場合は何もしない（呼び出し元で制御するが念のため）
    const notification = document.createElement('div');
    notification.className = 'ai-meta-error-notification';
    notification.textContent = message;

    document.body.appendChild(notification);

    // 3秒後に消える
    setTimeout(() => {
        notification.style.opacity = '0';
        notification.style.transform = 'translateY(10px)';
        notification.addEventListener('transitionend', () => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        });
    }, 3000);
}

/**
 * 生成ツールを判別
 * @param {Object} metadata - 生のメタデータ
 * @returns {string} - ツール名とバージョン（例: "NovelAI V4.5", "ComfyUI workflow", "Civitai", "Stable Diffusion WebUI"）
 */
function detectGenerator(metadata) {
    // Midjourney
    // Description に "Job ID:" または "--v" (バージョンフラグ) が含まれている場合
    if (metadata.Description) {
        const desc = metadata.Description;

        // Job ID の存在チェック（最も確実）
        if (desc.includes('Job ID:')) {
            // バージョン抽出 (例: "--v 7" -> "V7")
            const versionMatch = desc.match(/--v\s+(\d+(?:\.\d+)?)/);
            const version = versionMatch ? ` V${versionMatch[1]}` : '';
            return `Midjourney${version}`;
        }

        // Midjourneyパラメータの存在チェック（--ar, --profile など）
        if (desc.match(/--(?:ar|v|profile|chaos|quality|style|stylize|weird|tile|no|stop|video|seed|sref|cref)\s+/)) {
            const versionMatch = desc.match(/--v\s+(\d+(?:\.\d+)?)/);
            const version = versionMatch ? ` V${versionMatch[1]}` : '';
            return `Midjourney${version}`;
        }
    }

    // NovelAI
    // Comment キーが存在する、または Description に NovelAI 特有のパターンがある場合
    if (metadata.Comment) {
        let version = '';
        try {
            const json = JSON.parse(metadata.Comment);
            // inputフィールドなどからバージョンを探すヒューリスティック
            // 例: "NovelAI Diffusion V4.5 1229B44F"
            const jsonStr = JSON.stringify(json);
            const match = jsonStr.match(/NovelAI Diffusion V([\d.]+)/);
            if (match) {
                version = ` V${match[1]}`;
            }
        } catch (e) { }
        return `NovelAI${version}`;
    }

    // Description のみでは NovelAI と判定しない（Midjourneyと区別するため）
    // ただし、Description に "NovelAI" という文字列が含まれている場合は例外
    if (metadata.Description && metadata.Description.includes('NovelAI')) {
        return 'NovelAI';
    }

    // Tensor.art
    // generation_dataキーがあり、かつprompt内にECHOCheckpointLoaderSimpleがある場合
    if (metadata.generation_data && metadata.prompt && metadata.prompt.includes('ECHOCheckpointLoaderSimple')) {
        return 'Tensor.art';
    }

    // ComfyUI
    // workflowまたはgeneration_dataキーが存在する場合（Tensor.artでない場合）
    // または parameters 内に ComfyUI という文字列が含まれている場合
    if (metadata.workflow || metadata.generation_data || (metadata.parameters && metadata.parameters.includes('ComfyUI'))) {
        return 'ComfyUI';
    }

    // Civitai
    // parameters内に「Civitai metadata」がある、または Version: v... がある場合
    if (metadata.parameters) {
        if (metadata.parameters.includes('Civitai metadata')) {
            return 'Civitai';
        }
        // Version: v1.10.xxxxx などのパターンを検出 (Civitai生成画像の特徴)
        if (metadata.parameters.match(/Version:\s*v1\.10\./)) {
            return 'Civitai';
        }
    }

    // Stable Diffusion WebUI (デフォルト)
    return 'Stable Diffusion WebUI';
}

/**
 * メタデータをタブ用に解析・分類
 * @param {Object} metadata - 生のメタデータ
 * @returns {Object} - 分類されたデータ { positive, negative, other }
 */
function parseMetadataToTabs(metadata) {
    let positive = '';
    let negative = '';
    let otherObj = { ...metadata }; // コピーを作成

    // parameters (Stable Diffusion A1111)
    if (metadata.parameters) {
        const params = metadata.parameters;
        const negIndex = params.indexOf('Negative prompt:');
        const stepsIndex = params.indexOf('Steps:');

        if (negIndex !== -1) {
            positive = params.substring(0, negIndex).trim();

            if (stepsIndex !== -1) {
                negative = params.substring(negIndex + 'Negative prompt:'.length, stepsIndex).trim();
            } else {
                negative = params.substring(negIndex + 'Negative prompt:'.length).trim();
            }
        } else {
            if (stepsIndex !== -1) {
                positive = params.substring(0, stepsIndex).trim();
            } else {
                positive = params.trim();
            }
        }

        // Steps以降を取得してOther Settingsに追加
        if (stepsIndex !== -1) {
            otherObj['parameters_settings'] = params.substring(stepsIndex).trim();
        }
        delete otherObj['parameters']; // 元のparametersは削除
    }

    // prompt / workflow / generation_data (ComfyUI)
    else if (metadata.prompt || metadata.workflow || metadata.generation_data) {
        if (metadata.prompt) {
            try {
                const json = JSON.parse(metadata.prompt);
                positive = JSON.stringify(json, null, 2);
                delete otherObj['prompt'];
            } catch (e) {
                positive = metadata.prompt;
                delete otherObj['prompt'];
            }
        }
        // workflow, generation_dataはそのままOtherに残る
    }

    // Description / Comment (NovelAI)
    else if (metadata.Description || metadata.Comment) {
        if (metadata.Description) {
            positive = metadata.Description;
            delete otherObj['Description'];
        }

        // Comment内のnegative promptを抽出 (NovelAI v3/v4/v4.5対応)
        if (metadata.Comment) {
            try {
                const commentJson = JSON.parse(metadata.Comment);

                // 優先度1: "uc" キー (Undesired Content)
                if (commentJson.uc) {
                    negative = commentJson.uc;
                } else {
                    // 優先度2: "negative" を含むキーを検索
                    for (const key in commentJson) {
                        if (key.includes('negative')) {
                            const val = commentJson[key];
                            if (typeof val === 'string') {
                                negative = val;
                            } else if (typeof val === 'object' && val !== null) {
                                // v4_negative_prompt: { caption: { base_caption: "..." } }
                                if (val.caption && val.caption.base_caption) {
                                    negative = val.caption.base_caption;
                                } else {
                                    // 構造が不明な場合はJSON文字列化
                                    negative = JSON.stringify(val, null, 2);
                                }
                            }
                            break;
                        }
                    }
                }
            } catch (e) {
                // JSON parseに失敗した場合は何もしない
            }
        }
        // CommentはそのままOtherに残る
    }

    // Other Settings用のオブジェクト
    // parameters_settingsがあれば優先的に表示
    const other = {};
    if (otherObj['parameters_settings']) {
        other['parameters_settings'] = otherObj['parameters_settings'];
        delete otherObj['parameters_settings'];
    }

    // 残りのメタデータをすべてotherに追加
    Object.assign(other, otherObj);

    return { positive, negative, other };
}

/**
 * コピー機能の実装
 * @param {HTMLElement} button - トリガーとなるボタン
 * @param {string} text - コピーするテキスト
 */
function setupCopyButton(button, text) {
    button.addEventListener('click', async (e) => {
        e.stopPropagation(); // 親要素へのイベント伝播を防ぐ
        try {
            await navigator.clipboard.writeText(text);

            // ツールチップの表示更新
            const originalTitle = button.getAttribute('data-tooltip');
            button.setAttribute('data-tooltip', 'Copied!');
            button.classList.add('copied');

            setTimeout(() => {
                button.setAttribute('data-tooltip', originalTitle);
                button.classList.remove('copied');
            }, 2000);
        } catch (err) {
            console.error('Failed to copy text: ', err);
        }
    });
}

/**
 * モーダル要素を作成
 * @param {Object} metadata - メタデータ
 * @returns {HTMLElement} - モーダルオーバーレイ要素
 */
function createModal(metadata) {
    const { positive, negative, other } = parseMetadataToTabs(metadata);
    const generatorName = detectGenerator(metadata);

    // オーバーレイ
    const overlay = document.createElement('div');
    overlay.className = 'ai-meta-modal-overlay';

    // モーダルコンテナ
    const modal = document.createElement('div');
    modal.className = 'ai-meta-modal';

    // ヘッダー
    const header = document.createElement('div');
    header.className = 'ai-meta-modal-header';

    const title = document.createElement('h2');
    title.textContent = `Image Metadata - ${generatorName}`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ai-meta-close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Close';

    header.appendChild(title);
    header.appendChild(closeBtn);

    // コンテンツエリア
    const content = document.createElement('div');
    content.className = 'ai-meta-modal-content';

    // セクション作成ヘルパー
    const createSection = (titleText, textContent, className) => {
        const section = document.createElement('div');
        section.className = `ai-meta-section ${className}`;

        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'ai-meta-section-header';

        const label = document.createElement('span');
        label.className = 'ai-meta-section-label';
        label.textContent = titleText;

        const copyBtn = document.createElement('button');
        copyBtn.className = 'ai-meta-copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.setAttribute('data-tooltip', 'Copy to clipboard');
        setupCopyButton(copyBtn, textContent);

        sectionHeader.appendChild(label);
        sectionHeader.appendChild(copyBtn);

        const textArea = document.createElement('div');
        textArea.className = 'ai-meta-text-area';
        textArea.textContent = textContent || 'None';
        if (!textContent) textArea.classList.add('empty');

        section.appendChild(sectionHeader);
        section.appendChild(textArea);

        return section;
    };

    // 各セクション追加
    content.appendChild(createSection('Positive Prompt', positive, 'positive-section'));
    content.appendChild(createSection('Negative Prompt', negative, 'negative-section'));

    // Other Settings セクション（特別処理）
    const otherSection = document.createElement('div');
    otherSection.className = 'ai-meta-section other-section';

    const otherHeader = document.createElement('div');
    otherHeader.className = 'ai-meta-section-header';

    const otherLabel = document.createElement('span');
    otherLabel.className = 'ai-meta-section-label';
    otherLabel.textContent = 'Other Settings';

    // Other全体のコピーボタン
    const otherCopyBtn = document.createElement('button');
    otherCopyBtn.className = 'ai-meta-copy-btn';
    otherCopyBtn.textContent = 'Copy';
    otherCopyBtn.setAttribute('data-tooltip', 'Copy all other settings');

    // otherオブジェクトを文字列化（キー: 値の形式）
    let otherText = '';
    if (other && typeof other === 'object' && Object.keys(other).length > 0) {
        for (const [key, value] of Object.entries(other)) {
            // 値が長い場合は改行を入れる
            const valueStr = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
            otherText += `${key}:\n${valueStr}\n\n`;
        }
        otherText = otherText.trim();
    }

    setupCopyButton(otherCopyBtn, otherText || 'None');

    otherHeader.appendChild(otherLabel);
    otherHeader.appendChild(otherCopyBtn);

    const otherTextArea = document.createElement('div');
    otherTextArea.className = 'ai-meta-text-area';

    if (other && typeof other === 'object' && Object.keys(other).length > 0) {
        // キーと値のリスト形式で表示
        for (const [key, value] of Object.entries(other)) {
            const itemDiv = document.createElement('div');
            itemDiv.className = 'ai-meta-other-item';
            itemDiv.style.marginBottom = '12px';

            const keySpan = document.createElement('div');
            keySpan.style.fontWeight = 'bold';
            keySpan.style.marginBottom = '4px';
            keySpan.style.color = '#4a9eff';
            keySpan.textContent = key;

            const valueDiv = document.createElement('div');
            valueDiv.style.whiteSpace = 'pre-wrap';
            valueDiv.style.wordBreak = 'break-word';
            valueDiv.style.fontFamily = 'monospace';
            valueDiv.style.fontSize = '0.9em';

            // 値が長いJSON等の場合は整形
            const valueStr = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);

            // parameters_settingsの場合、項目ごとに異なる色でハイライト
            if (key === 'parameters_settings' && typeof valueStr === 'string') {
                // XSS対策: HTMLエンティティをエスケープしてからハイライト処理を行う
                const escapeHtml = (str) => str.replace(/[&<>"']/g, m => ({
                    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
                }[m]));

                let highlighted = escapeHtml(valueStr);

                // 1. Model関連 (青系)
                highlighted = highlighted.replace(
                    /(Model:\s*[^,]+)/gi,
                    '<span style="color: #4a9eff; font-weight: bold;">$1</span>'
                );

                // 2. ADetailer関連 (紫系)
                highlighted = highlighted.replace(
                    /(ADetailer[^:]*:\s*[^,]+)/gi,
                    '<span style="color: #bb86fc; font-weight: bold;">$1</span>'
                );

                // 3. Hires関連 (緑系)
                highlighted = highlighted.replace(
                    /(Hires\s+checkpoint:\s*[^,]+|Hires\s+(?:Module\s+\d+|CFG\s+Scale|upscale|steps|upscaler):\s*[^,]+)/gi,
                    '<span style="color: #03dac6; font-weight: bold;">$1</span>'
                );

                // 4. Lora関連 (黄系)
                highlighted = highlighted.replace(
                    /(Lora\s+hashes:\s*(?:"[^"]+"|\{[^\}]+\}|[^,]+))/gi,
                    '<span style="color: #ffcb2b; font-weight: bold;">$1</span>'
                );

                valueDiv.innerHTML = highlighted;
            } else {
                valueDiv.textContent = valueStr;
            }

            itemDiv.appendChild(keySpan);
            itemDiv.appendChild(valueDiv);
            otherTextArea.appendChild(itemDiv);
        }
    } else {
        otherTextArea.textContent = 'None';
        otherTextArea.classList.add('empty');
    }

    otherSection.appendChild(otherHeader);
    otherSection.appendChild(otherTextArea);
    content.appendChild(otherSection);

    // フッター
    const footer = document.createElement('div');
    footer.className = 'ai-meta-modal-footer';

    const copyAllBtn = document.createElement('button');
    copyAllBtn.className = 'ai-meta-copy-all-btn';
    copyAllBtn.textContent = 'Copy All Data';
    copyAllBtn.setAttribute('data-tooltip', 'Copy all metadata (raw format)');

    // 全データをraw形式で結合（JSON化しない）
    let allDataRaw = '';
    for (const [key, value] of Object.entries(metadata)) {
        const valueStr = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
        allDataRaw += `${key}:\n${valueStr}\n\n`;
    }
    allDataRaw = allDataRaw.trim();

    setupCopyButton(copyAllBtn, allDataRaw);

    footer.appendChild(copyAllBtn);

    // 組み立て
    modal.appendChild(header);
    modal.appendChild(content);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    // イベントハンドラ
    const close = () => {
        if (document.body) {
            if (overlay.parentNode === document.body) {
                document.body.removeChild(overlay);
            }
            document.body.style.overflow = ''; // スクロールロック解除
        }
    };

    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });
    header.addEventListener('click', (e) => {
        // ヘッダーをクリックしても閉じる（仕様書2.2.2項）
        // ただし、閉じるボタン自体のクリックイベントと競合しないようにする
        if (e.target !== closeBtn) close();
    });

    // Escキーで閉じる
    const escHandler = (e) => {
        if (e.key === 'Escape') {
            close();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);

    // スクロールロック
    if (document.body) {
        document.body.style.overflow = 'hidden';
    }

    return overlay;
}

/**
 * ページ内ダウンローダー起動ボタンを作成
 * @returns {HTMLElement}
 */
function createDownloadButton() {
    const btn = document.createElement('div');
    btn.className = 'ai-meta-download-fab';
    btn.innerHTML = `
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="white" stroke-width="2">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
        </svg>
    `;
    btn.title = 'Download AI Images';

    // スタイル (JSで直接書いても良いがCSSの方が管理しやすい)
    // ここでは最低限だけ設定し、詳細はstyles.cssで
    btn.style.position = 'fixed';
    btn.style.bottom = '20px';
    btn.style.right = '20px'; // エラー通知と被らないように調整が必要かも
    btn.style.zIndex = '2147483646'; // モーダルより下、バッジより上

    return btn;
}

/**
 * ダウンローダーモーダルを作成
 * @param {Array} images - [{url, filename, metadata}, ...]
 * @returns {HTMLElement}
 */
/**
 * ダウンローダーモーダルを作成
 * @param {Array} images - [{url, filename, metadata, isAI}, ...]
 * @param {Object} context - {pageTitle, domain}
 * @returns {HTMLElement}
 */
function createDownloaderModal(images, context) {
    const { pageTitle, domain } = context || {};
    const overlay = document.createElement('div');
    overlay.className = 'ai-meta-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'ai-meta-modal ai-meta-downloader-modal';

    // ヘッダー
    const header = document.createElement('div');
    header.className = 'ai-meta-modal-header';
    header.innerHTML = `<h2>Select Images to Download</h2>`;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ai-meta-close-btn';
    closeBtn.innerHTML = '&times;';
    header.appendChild(closeBtn);

    // フィルタ・設定エリア
    const toolbar = document.createElement('div');
    toolbar.className = 'ai-meta-downloader-toolbar';
    toolbar.style.padding = '12px 16px';
    toolbar.style.borderBottom = '1px solid #333';
    toolbar.style.display = 'flex';
    toolbar.style.justifyContent = 'space-between';
    toolbar.style.alignItems = 'center';
    toolbar.style.flexWrap = 'wrap';
    toolbar.style.gap = '10px';

    // フィルタボタン
    const filterGroup = document.createElement('div');
    filterGroup.className = 'ai-meta-filter-group';
    filterGroup.style.display = 'flex';
    filterGroup.style.gap = '8px';

    const filterAI = document.createElement('button');
    filterAI.textContent = 'AI Images Only';
    filterAI.className = 'ai-meta-filter-btn active';
    filterAI.style.padding = '4px 12px';
    filterAI.style.borderRadius = '4px';
    filterAI.style.border = '1px solid #4a9eff';
    filterAI.style.background = '#4a9eff';
    filterAI.style.color = 'white';
    filterAI.style.cursor = 'pointer';

    const filterAll = document.createElement('button');
    filterAll.textContent = 'Show All';
    filterAll.className = 'ai-meta-filter-btn';
    filterAll.style.padding = '4px 12px';
    filterAll.style.borderRadius = '4px';
    filterAll.style.border = '1px solid #555';
    filterAll.style.background = 'transparent';
    filterAll.style.color = '#aaa';
    filterAll.style.cursor = 'pointer';

    filterGroup.appendChild(filterAI);
    filterGroup.appendChild(filterAll);

    // 保存先ヒント
    const saveHint = document.createElement('div');
    saveHint.className = 'ai-meta-save-hint';
    saveHint.style.fontSize = '12px';
    saveHint.style.color = '#888';

    // 非同期で設定を読み込んでヒントを更新
    chrome.storage.sync.get({ downloaderFolderMode: 'pageTitle' }, (settings) => {
        let path = 'AI_Meta_Viewer/';
        if (settings.downloaderFolderMode === 'pageTitle' && pageTitle) {
            path += pageTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, 20) + '.../';
        } else if (settings.downloaderFolderMode === 'domain' && domain) {
            path += domain + '/';
        }
        saveHint.innerHTML = `Save path: <code style="color: #4a9eff;">${path}</code>`;
    });

    toolbar.appendChild(filterGroup);
    toolbar.appendChild(saveHint);

    // コンテンツ (グリッド表示)
    const content = document.createElement('div');
    content.className = 'ai-meta-modal-content ai-meta-downloader-grid';
    content.style.display = 'grid';
    content.style.gridTemplateColumns = 'repeat(auto-fill, minmax(120px, 1fr))';
    content.style.gap = '12px';
    content.style.padding = '16px';
    content.style.maxHeight = '60vh';
    content.style.overflowY = 'auto';

    // 画像アイテム作成
    const renderImages = (onlyAI = true) => {
        content.innerHTML = '';
        const targets = onlyAI ? images.filter(img => img.isAI) : images;

        targets.forEach((img, idx) => {
            const item = document.createElement('div');
            item.className = 'ai-meta-downloader-item';
            item.style.position = 'relative';
            item.style.aspectRatio = '1';
            item.style.cursor = 'pointer';
            item.style.border = '2px solid #4a9eff';
            item.style.borderRadius = '4px';
            item.style.overflow = 'hidden';
            item.dataset.selected = 'true';
            item.dataset.url = img.url;

            const thumb = document.createElement('img');
            thumb.src = img.url;
            thumb.style.width = '100%';
            thumb.style.height = '100%';
            thumb.style.objectFit = 'cover';

            // AIバッジ（グリッド内）
            if (img.isAI) {
                const aiIndicator = document.createElement('div');
                aiIndicator.textContent = 'AI';
                aiIndicator.style.position = 'absolute';
                aiIndicator.style.top = '4px';
                aiIndicator.style.right = '4px';
                aiIndicator.style.background = 'rgba(74, 158, 255, 0.9)';
                aiIndicator.style.color = 'white';
                aiIndicator.style.fontSize = '10px';
                aiIndicator.style.padding = '1px 4px';
                aiIndicator.style.borderRadius = '2px';
                aiIndicator.style.fontWeight = 'bold';
                item.appendChild(aiIndicator);
            }

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.style.position = 'absolute';
            checkbox.style.bottom = '4px';
            checkbox.style.left = '4px';
            checkbox.style.width = '16px';
            checkbox.style.height = '16px';
            checkbox.style.accentColor = '#4a9eff';

            item.appendChild(thumb);
            item.appendChild(checkbox);

            item.addEventListener('click', (e) => {
                const isSelected = item.dataset.selected === 'true';
                if (isSelected) {
                    item.dataset.selected = 'false';
                    item.style.border = '2px solid transparent';
                    item.style.opacity = '0.4';
                    checkbox.checked = false;
                } else {
                    item.dataset.selected = 'true';
                    item.style.border = '2px solid #4a9eff';
                    item.style.opacity = '1';
                    checkbox.checked = true;
                }
                updateDownloadBtn();
            });

            content.appendChild(item);
        });
        updateDownloadBtn();
    };

    // フッター
    const footer = document.createElement('div');
    footer.className = 'ai-meta-modal-footer';
    footer.style.display = 'flex';
    footer.style.justifyContent = 'space-between';
    footer.style.alignItems = 'center';

    const stats = document.createElement('span');
    stats.style.fontSize = '13px';
    stats.style.color = '#888';

    const dlBtn = document.createElement('button');
    dlBtn.className = 'ai-meta-copy-all-btn';
    dlBtn.style.backgroundColor = '#4a9eff';
    dlBtn.style.color = '#fff';

    footer.appendChild(stats);
    footer.appendChild(dlBtn);

    const updateDownloadBtn = () => {
        const selectedItems = content.querySelectorAll('.ai-meta-downloader-item[data-selected="true"]');
        const count = selectedItems.length;
        dlBtn.textContent = `Download Selected (${count})`;
        dlBtn.disabled = count === 0;
        dlBtn.style.opacity = count === 0 ? '0.5' : '1';
        stats.textContent = `Selected: ${count} / Total on page: ${images.length}`;
    };

    // フィルタ切り替えイベント
    filterAI.onclick = () => {
        filterAI.style.background = '#4a9eff';
        filterAI.style.color = 'white';
        filterAI.style.border = '1px solid #4a9eff';
        filterAll.style.background = 'transparent';
        filterAll.style.color = '#aaa';
        filterAll.style.border = '1px solid #555';
        renderImages(true);
    };

    filterAll.onclick = () => {
        filterAll.style.background = '#4a9eff';
        filterAll.style.color = 'white';
        filterAll.style.border = '1px solid #4a9eff';
        filterAI.style.background = 'transparent';
        filterAI.style.color = '#aaa';
        filterAI.style.border = '1px solid #555';
        renderImages(false);
    };

    dlBtn.onclick = () => {
        const selectedItems = content.querySelectorAll('.ai-meta-downloader-item[data-selected="true"]');
        const targets = Array.from(selectedItems).map(item => {
            const url = item.dataset.url;
            const originalData = images.find(img => img.url === url);
            return {
                url: url,
                filename: originalData ? originalData.filename : 'image.png'
            };
        });

        if (targets.length > 0) {
            dlBtn.disabled = true;
            dlBtn.textContent = 'Processing...';

            chrome.runtime.sendMessage({
                action: 'downloadImages',
                images: targets,
                context: { pageTitle, domain } // フォルダ名決定のため
            }, (response) => {
                if (response && response.success) {
                    dlBtn.textContent = 'Downloads Started!';
                    setTimeout(close, 1500);
                } else {
                    alert('Download failed: ' + (response ? response.error : 'Unknown error'));
                    updateDownloadBtn();
                }
            });
        }
    };

    // 初期化
    renderImages(true); // AI画像のみをデフォルト

    modal.appendChild(header);
    modal.appendChild(toolbar);
    modal.appendChild(content);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    // 閉じる処理
    const close = () => {
        if (overlay.parentNode) {
            document.body.removeChild(overlay);
            document.body.style.overflow = '';
        }
    };

    closeBtn.onclick = close;
    overlay.onclick = (e) => { if (e.target === overlay) close(); };

    document.body.style.overflow = 'hidden';
    return overlay;
}
