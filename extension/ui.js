// ui.js - UIコンポーネントモジュール

/**
 * バッジ要素を作成
 * @returns {HTMLElement} - バッジ要素
 */
function createBadge() {
    const badge = document.createElement('div');
    badge.className = 'ai-meta-badge';
    badge.textContent = 'View Metadata';
    badge.title = 'Click to view image metadata';
    return badge;
}

/**
 * 生成ツールを判別
 * @param {Object} metadata - 生のメタデータ
 * @returns {string} - ツール名とバージョン（例: "NovelAI V4.5", "ComfyUI workflow", "Civitai", "Stable Diffusion WebUI"）
 */
function detectGenerator(metadata) {
    // NovelAI
    if (metadata.Comment || metadata.Description) {
        let version = '';
        try {
            // Comment内のJSONからバージョンを探す
            if (metadata.Comment) {
                const json = JSON.parse(metadata.Comment);
                // inputフィールドなどからバージョンを探すヒューリスティック
                // 例: "NovelAI Diffusion V4.5 1229B44F"
                // JSON構造は不定だが、文字列化して検索
                const jsonStr = JSON.stringify(json);
                const match = jsonStr.match(/NovelAI Diffusion V([\d.]+)/);
                if (match) {
                    version = ` V${match[1]}`;
                }
            }
        } catch (e) { }
        return `NovelAI${version}`;
    }

    // Tensor.art
    // generation_dataキーがあり、かつprompt内にECHOCheckpointLoaderSimpleがある場合
    if (metadata.generation_data && metadata.prompt && metadata.prompt.includes('ECHOCheckpointLoaderSimple')) {
        return 'Tensor.art';
    }

    // ComfyUI
    // workflowまたはgeneration_dataキーが存在する場合（Tensor.artでない場合）
    if (metadata.workflow || metadata.generation_data) {
        return 'ComfyUI workflow';
    }

    // Civitai
    // parameters内に「Civitai metadata」という文字列がある場合
    if (metadata.parameters && metadata.parameters.includes('Civitai metadata')) {
        return 'Civitai';
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
        // CommentはSettingsとしてOtherに残る
    }

    // Other Settings用の文字列生成
    let other = '';
    if (Object.keys(otherObj).length > 0) {
        other = JSON.stringify(otherObj, null, 2);
    }

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
    content.appendChild(createSection('Other Settings', other, 'other-section'));

    // フッター
    const footer = document.createElement('div');
    footer.className = 'ai-meta-modal-footer';

    const copyAllBtn = document.createElement('button');
    copyAllBtn.className = 'ai-meta-copy-all-btn';
    copyAllBtn.textContent = 'Copy All Data';
    copyAllBtn.setAttribute('data-tooltip', 'Copy all metadata');

    // 全データ結合 (元のmetadataオブジェクト全体をJSON化)
    const allData = JSON.stringify(metadata, null, 2);

    setupCopyButton(copyAllBtn, allData);

    footer.appendChild(copyAllBtn);

    // 組み立て
    modal.appendChild(header);
    modal.appendChild(content);
    modal.appendChild(footer);
    overlay.appendChild(modal);

    // イベントハンドラ
    const close = () => {
        document.body.removeChild(overlay);
        document.body.style.overflow = ''; // スクロールロック解除
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
    document.body.style.overflow = 'hidden';

    return overlay;
}
