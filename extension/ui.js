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
        const previewSection = buildSections(metadata).find(section => section.id === 'positive');
        const positive = previewSection ? previewSection.text : '';
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
    const source = metadata && typeof metadata === 'object' ? metadata : {};

    // Midjourney
    // Description に "Job ID:" または "--v" (バージョンフラグ) が含まれている場合
    if (typeof source.Description === 'string' && source.Description) {
        const desc = source.Description;

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
    if (source.Comment) {
        let version = '';
        try {
            const json = JSON.parse(source.Comment);
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
    if (typeof source.Description === 'string' && source.Description.includes('NovelAI')) {
        return 'NovelAI';
    }

    // Tensor.art
    // generation_dataキーがあり、かつprompt内にECHOCheckpointLoaderSimpleがある場合
    if (source.generation_data && typeof source.prompt === 'string' &&
        source.prompt.includes('ECHOCheckpointLoaderSimple')) {
        return 'Tensor.art';
    }

    // ComfyUI
    // workflowまたはgeneration_dataキーが存在する場合（Tensor.artでない場合）
    // または parameters 内に ComfyUI という文字列が含まれている場合
    if (source.workflow || source.generation_data ||
        (typeof source.parameters === 'string' && source.parameters.includes('ComfyUI'))) {
        return 'ComfyUI';
    }

    // Civitai
    // parameters内に「Civitai metadata」がある、または Version: v... がある場合
    if (typeof source.parameters === 'string') {
        if (source.parameters.includes('Civitai metadata')) {
            return 'Civitai';
        }
        // Version: v1.10.xxxxx などのパターンを検出 (A1111とCivitai生成画像の特徴)
        if (source.parameters.match(/Version:\s*v1\.10\./)) {
            return 'A1111';
        }
    }

    // Stable Diffusion WebUI (デフォルト)
    return 'Stable Diffusion WebUI';
}

/**
 * ドット区切りのパスから値を安全に取得する。
 * @param {Object|null} object - 検索対象
 * @param {string} path - ドット区切りのパス
 * @returns {*} - 取得値、存在しない場合は undefined
 */
function safeGet(object, path) {
    try {
        return path.split('.').reduce((value, key) => (
            value == null ? undefined : value[key]
        ), object);
    } catch (error) {
        return undefined;
    }
}

/**
 * 値を表示用の文字列へ変換する。
 * @param {*} value - 変換対象
 * @returns {string} - 表示文字列
 */
function toDisplayText(value) {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        const serialized = JSON.stringify(value, null, 2);
        return serialized == null ? '' : serialized;
    } catch (error) {
        return '';
    }
}

/**
 * caption/prompt/uc 系の値を深さと件数を制限して再帰回収する。
 * @param {*} value - 検索対象
 * @returns {Array<{key:string,text:string,path:string}>} - 回収結果
 */
function collectCaptionsLike(value) {
    const MAX_DEPTH = 6;
    const MAX_RESULTS = 400;
    const results = [];
    const visited = new Set();
    const keyPattern = /(?:caption|prompt|uc|u[_-]?c|text|char|negative|undesired)/i;

    const visit = (current, depth, path) => {
        if (results.length >= MAX_RESULTS || depth > MAX_DEPTH || current == null) return;
        if (typeof current !== 'object' || visited.has(current)) return;
        visited.add(current);

        for (const [key, child] of Object.entries(current)) {
            if (results.length >= MAX_RESULTS) break;
            const childPath = path ? `${path}.${key}` : key;
            if (typeof child === 'string' && child.trim() && keyPattern.test(key)) {
                results.push({ key, text: child, path: childPath });
            } else if (child && typeof child === 'object') {
                visit(child, depth + 1, childPath);
            }
        }
    };

    visit(value, 0, '');
    return results;
}

/**
 * Comment 内のパスが負値系かを判定する。
 * @param {string} path - Comment 相対パス
 * @returns {boolean} - 負値系なら true
 */
function isNegativeCaptionPath(path) {
    return /negative|undesired|(?:^|\.)(?:uc|u[_-]?c)(?:\.|$)/i.test(path);
}

/**
 * Comment 内のパスがキャラクター系かを判定する。
 * @param {string} path - Comment 相対パス
 * @returns {boolean} - キャラクター系なら true
 */
function isCharacterCaptionPath(path) {
    return /char/i.test(path);
}

/**
 * NovelAI の Comment JSON を一度だけ安全に解析する。
 * @param {*} comment - Comment 値
 * @returns {Object|null} - 解析結果
 */
function parseCommentObject(comment) {
    if (!comment) return null;
    if (typeof comment === 'object') return comment;
    if (typeof comment !== 'string') return null;
    try {
        const parsed = JSON.parse(comment);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (error) {
        return null;
    }
}

/**
 * NovelAI のベース負値を既存優先順で抽出する。
 * @param {Object|null} comment - 解析済みComment JSON
 * @returns {{text:string,dataFields:string[]}} - 負値本文と書き戻し先
 */
function extractNovelAiNegative(comment) {
    const uc = toDisplayText(safeGet(comment, 'uc')).trim();
    const v4BasePath = 'v4_negative_prompt.caption.base_caption';
    const v4Base = toDisplayText(safeGet(comment, v4BasePath)).trim();
    const dataFields = [];
    if (uc) dataFields.push('comment.uc');
    if (v4Base) dataFields.push(`comment.${v4BasePath}`);

    if (uc) return { text: uc, dataFields };
    if (v4Base) return {
        text: v4Base,
        dataFields
    };

    const fallback = collectCaptionsLike(comment).find(entry =>
        isNegativeCaptionPath(entry.path) && !isCharacterCaptionPath(entry.path)
    );
    if (fallback) return {
        text: fallback.text.trim(),
        dataFields: [`comment.${fallback.path}`]
    };

    return { text: '', dataFields: [] };
}

/**
 * キャラクター負値の重複本文を除外する。
 * @param {Array<Object>} children - キャラクター負値
 * @param {string} baseText - ベース負値
 * @returns {Array<Object>} - 重複除外後のキャラクター負値
 */
function dedupeNegativeCharacterChildren(children, baseText) {
    const seen = new Set();
    const base = toDisplayText(baseText).trim();
    if (base) seen.add(base);
    return children.filter(child => {
        const text = toDisplayText(child && child.text).trim();
        if (!text || seen.has(text)) return false;
        seen.add(text);
        return true;
    });
}

/**
 * セクションモデルの要素を作成する。
 * @param {string} id - 識別子
 * @param {string} name - 表示名
 * @param {string} kind - セクション種別
 * @param {boolean} defaultOpen - 初期展開状態
 * @param {*} text - 初期テキスト
 * @param {Object} extras - 追加属性
 * @returns {Object} - セクションモデル
 */
function createSectionModel(id, name, kind, defaultOpen, text, extras = {}) {
    const section = {
        id,
        name,
        kind,
        defaultOpen,
        text: toDisplayText(text)
    };
    if (extras.highlight) section.highlight = true;
    if (Array.isArray(extras.dataFields) && extras.dataFields.length > 0) {
        section.dataFields = extras.dataFields;
    }
    if (Array.isArray(extras.children) && extras.children.length > 0) {
        section.children = extras.children;
    }
    return section;
}

/**
 * NovelAI のキャプション配列をセクション子要素へ変換する。
 * @param {*} captions - キャプション配列
 * @param {string} pathPrefix - data-field の接頭辞
 * @returns {Array<Object>} - 子要素
 */
function buildCharacterChildren(captions, pathPrefix) {
    if (!Array.isArray(captions)) return [];
    return captions.map((caption, index) => {
        if (!caption || typeof caption !== 'object') return null;
        const text = caption.char_caption || caption.caption || caption.prompt || '';
        if (!toDisplayText(text)) return null;
        let fieldName = 'char_caption';
        if (caption.char_caption == null && caption.caption != null) fieldName = 'caption';
        if (caption.char_caption == null && caption.caption == null && caption.prompt != null) fieldName = 'prompt';
        return {
            label: `Character ${index + 1}`,
            text: toDisplayText(text),
            dataFields: [`${pathPrefix}.${index}.${fieldName}`]
        };
    }).filter(Boolean);
}

/**
 * 固定パスで取得できないキャラクターキャプションを回収する。
 * @param {*} comment - NovelAI Comment JSON
 * @param {boolean} negative - ネガティブ側だけを対象にするか
 * @returns {Array<Object>} - セクション子要素
 */
function collectCharacterChildrenFallback(comment, negative = false) {
    return collectCaptionsLike(comment)
        .filter(entry => {
            const isNegativePath = isNegativeCaptionPath(entry.path);
            return isCharacterCaptionPath(entry.path) && (negative === isNegativePath);
        })
        .map((entry, index) => ({
            label: `Character ${index + 1}`,
            text: entry.text,
            dataFields: [`comment.${entry.path}`]
        }));
}

/**
 * A1111系メタデータをセクションモデルへ変換する。
 * @param {Object} source - 生のメタデータ
 * @returns {Array<Object>} - A1111系セクション
 */
function buildA1111Sections(source) {
    const parameters = typeof source.parameters === 'string' ? source.parameters : '';
    const negativeMarker = 'Negative prompt:';
    const negativeIndex = parameters.indexOf(negativeMarker);
    const stepsIndex = parameters.indexOf('Steps:');
    const parameterSettings = toDisplayText(source.parameters_settings).trim();
    const positive = negativeIndex >= 0
        ? parameters.substring(0, negativeIndex).trim()
        : parameters.substring(0, stepsIndex >= 0 ? stepsIndex : parameters.length).trim();
    const negative = negativeIndex >= 0
        ? parameters.substring(negativeIndex + negativeMarker.length,
            stepsIndex >= 0 ? stepsIndex : parameters.length).trim()
        : '';
    const settingsText = parameterSettings || (stepsIndex >= 0
        ? parameters.substring(stepsIndex).trim()
        : '');
    const sections = [];

    if (positive) {
        sections.push(createSectionModel(
            'positive', 'Positive Prompt', 'positive', true, positive,
            { dataFields: ['description'] }
        ));
    }
    if (negative) {
        sections.push(createSectionModel(
            'negative', 'Negative Prompt', 'negative', false, negative,
            { dataFields: ['negative_prompt'] }
        ));
    }
    if (settingsText) {
        sections.push(createSectionModel(
            'genSettings', 'Other Settings', 'settings', false, settingsText,
            { highlight: true, dataFields: ['parameters_settings'] }
        ));
    }
    return sections;
}

/**
 * NovelAI V3(legacy)のメタデータをセクションモデルへ変換する。
 * @param {Object} source - 生のメタデータ
 * @param {Object|null} comment - 解析済みComment JSON
 * @returns {Array<Object>} - V3用セクション
 */
function buildNovelAiLegacySections(source, comment) {
    const sections = [];
    const commentPrompt = toDisplayText(safeGet(comment, 'prompt'));
    const description = toDisplayText(source.Description);
    const promptText = commentPrompt || description;
    const promptFields = [];

    if (description) promptFields.push('description');
    if (commentPrompt) promptFields.push('comment.prompt');
    if (promptText) {
        sections.push(createSectionModel(
            'positive', 'Prompt', 'positive', true, promptText,
            { dataFields: promptFields }
        ));
    }

    const negative = extractNovelAiNegative(comment);
    if (negative.text) {
        sections.push(createSectionModel(
            'negative', 'Undesired Content', 'negative', false, negative.text,
            { dataFields: negative.dataFields }
        ));
    }

    const parameterKeys = ['seed', 'steps', 'sampler', 'scale', 'strength', 'noise', 'smea'];
    const parameterFields = [];
    const parameterLines = [];
    parameterKeys.forEach(key => {
        let value = comment && comment[key];
        let fieldKey = key;
        if ((value == null || value === '') && key === 'smea' && comment && comment.use_smea != null) {
            value = comment.use_smea;
            fieldKey = 'use_smea';
        }
        if (value != null && value !== '') {
            parameterLines.push(`${key}: ${toDisplayText(value)}`);
            parameterFields.push(`comment.${fieldKey}`);
        }
    });
    if (parameterLines.length > 0) {
        sections.push(createSectionModel(
            'novelaiParams', 'NovelAI Parameters', 'settings', false,
            parameterLines.join('\n'),
            { dataFields: parameterFields }
        ));
    }

    if (comment) {
        const rawComment = toDisplayText(comment);
        if (rawComment) {
            sections.push(createSectionModel(
                'rawComment', 'Raw Comment', 'raw', false, rawComment,
                { dataFields: ['raw_comment'] }
            ));
        }
    }
    return sections;
}

/**
 * Description または prompt を持つ未分類ジェネレータのセクションを構築する。
 * @param {Object} source - 生のメタデータ
 * @param {string} generatorName - 判定済みジェネレータ名
 * @returns {Array<Object>} - フォールバック用セクション
 */
function buildDescriptionSections(source, generatorName) {
    const description = toDisplayText(source.Description).trim();
    const prompt = description ? '' : toDisplayText(source.prompt).trim();
    const promptText = description || prompt;
    const promptField = description ? 'description' : (prompt ? 'prompt' : 'description');
    const promptLabel = description ? 'Description' : 'Prompt';
    const sections = [];

    if (promptText) {
        sections.push(createSectionModel(
            'positive', promptLabel, 'positive', true, promptText,
            { dataFields: [promptField] }
        ));
    }

    const otherEntries = Object.entries(source).filter(([key, value]) => {
        if (key === 'Description' || (key === 'prompt' && prompt)) return false;
        return value != null && value !== '';
    });
    if (otherEntries.length > 0) {
        const otherText = otherEntries.map(([key, value]) => {
            let valueText = toDisplayText(value);
            if (typeof value !== 'string') {
                try {
                    valueText = JSON.stringify(value, null, 2);
                } catch (error) {
                    valueText = toDisplayText(value);
                }
            }
            return `${key}:\n${valueText}`;
        }).join('\n\n').trim();
        if (otherText) {
            sections.push(createSectionModel(
                'other', 'Other Settings', 'settings', false, otherText,
                { dataFields: ['other'] }
            ));
        }
    }
    return sections;
}

/**
 * parseMetadataToTabs() を置き換える純粋なセクションモデル構築関数。
 * @param {Object|null} metadata - 生のメタデータ
 * @returns {Array<Object>} - 表示セクション
 */
function buildSectionsInternal(metadata) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const hasNovelAIComment = Boolean(source.Comment);
    const generatorName = hasNovelAIComment ? 'NovelAI' : detectGenerator(source);
    const sections = [];

    const isA1111Family = ['A1111', 'Civitai', 'Forge', 'Stable Diffusion WebUI']
        .includes(generatorName);
    if (isA1111Family && (typeof source.parameters === 'string' || source.parameters_settings)) {
        return buildA1111Sections(source);
    }

    const isComfyMetadata = generatorName === 'ComfyUI' ||
        Boolean(source.workflow || source.generation_data);
    const isDescriptionFallback = generatorName.startsWith('Midjourney') ||
        generatorName === 'Tensor.art' ||
        (!source.Comment && !isComfyMetadata &&
            (source.Description || source.prompt) && !generatorName.startsWith('NovelAI'));
    if (isDescriptionFallback) {
        return buildDescriptionSections(source, generatorName);
    }

    if (isComfyMetadata) {
        const formatComfyJson = value => {
            if (value == null || value === '') return '';
            if (typeof value === 'string') {
                try {
                    return JSON.stringify(JSON.parse(value), null, 2);
                } catch (error) {
                    return value;
                }
            }
            try {
                return JSON.stringify(value, null, 2);
            } catch (error) {
                return toDisplayText(value);
            }
        };

        const promptText = formatComfyJson(source.prompt);
        if (promptText) {
            sections.push(createSectionModel(
                'positive', 'Prompt', 'positive', true, promptText,
                { dataFields: ['comfy_prompt_json'] }
            ));
        }

        const workflowText = formatComfyJson(source.workflow);
        if (workflowText) {
            sections.push(createSectionModel(
                'workflow', 'workflow', 'settings', false, workflowText,
                { dataFields: ['comfy_workflow_json'] }
            ));
        }

        const other = { ...source };
        delete other.prompt;
        delete other.workflow;
        const otherText = formatComfyJson(other);
        if (otherText && otherText !== '{}') {
            sections.push(createSectionModel(
                'other', 'Other Settings', 'settings', false, otherText,
                { dataFields: ['other'] }
            ));
        }
        return sections;
    }

    if (generatorName.startsWith('NovelAI') || source.Description || source.Comment) {
        const comment = parseCommentObject(source.Comment);
        const hasNovelAiV4Prompt = Boolean(
            safeGet(comment, 'v4_prompt') || safeGet(comment, 'v4_negative_prompt')
        );
        const fallbackEntries = collectCaptionsLike(comment);
        const hasV4LikeCaptions = fallbackEntries.some(entry =>
            /(?:v4|caption|char|negative|undesired)/i.test(entry.path) &&
            entry.path !== 'prompt' && entry.path !== 'uc'
        );
        if (source.Comment && !hasNovelAiV4Prompt && !hasV4LikeCaptions) {
            return buildNovelAiLegacySections(source, comment);
        }
        const v4Base = safeGet(comment, 'v4_prompt.caption.base_caption');
        const legacyBase = safeGet(comment, 'prompt');
        let baseText = source.Description || v4Base || legacyBase || '';
        let baseFields = source.Description && v4Base
            ? ['description', 'comment.v4_prompt.caption.base_caption']
            : source.Description
                ? ['description']
                : v4Base
                    ? ['comment.v4_prompt.caption.base_caption']
                    : ['comment.prompt'];
        if (!baseText) {
            const fallbackBase = fallbackEntries.find(entry =>
                !isNegativeCaptionPath(entry.path) && !isCharacterCaptionPath(entry.path)
            );
            if (fallbackBase) {
                baseText = fallbackBase.text;
                baseFields = [`comment.${fallbackBase.path}`];
            }
        }
        if (baseText) {
            sections.push(createSectionModel(
                'positive', 'Base Prompt', 'positive', true, baseText,
                { dataFields: baseFields }
            ));
        }

        let positiveCharacters = buildCharacterChildren(
            safeGet(comment, 'v4_prompt.caption.char_captions'),
            'comment.v4_prompt.caption.char_captions'
        );
        if (positiveCharacters.length === 0) {
            positiveCharacters = collectCharacterChildrenFallback(comment, false);
        }
        if (positiveCharacters.length > 0) {
            sections.push(createSectionModel(
                'charPrompts', 'Character Prompts', 'positive', false, '',
                { children: positiveCharacters }
            ));
        }

        const negative = extractNovelAiNegative(comment);
        let negativeCharacters = buildCharacterChildren(
            safeGet(comment, 'v4_negative_prompt.caption.char_captions'),
            'comment.v4_negative_prompt.caption.char_captions'
        );
        if (negativeCharacters.length === 0) {
            negativeCharacters = collectCharacterChildrenFallback(comment, true);
        }
        negativeCharacters = dedupeNegativeCharacterChildren(negativeCharacters, negative.text);
        if (negativeCharacters.length > 0) {
            sections.push(createSectionModel(
                'charUndesired', 'Character Undesired Content', 'negative', false, '',
                { children: negativeCharacters }
            ));
        }

        if (negative.text) {
            sections.push(createSectionModel(
                'negative', 'Undesired Content', 'negative', false, negative.text,
                { dataFields: negative.dataFields }
            ));
        }

        const parameterKeys = ['seed', 'steps', 'sampler', 'scale', 'strength', 'noise', 'smea'];
        const parameterFields = [];
        const parameterLines = [];
        parameterKeys.forEach(key => {
            let value = comment && comment[key];
            let fieldKey = key;
            if ((value == null || value === '') && key === 'smea' && comment && comment.use_smea != null) {
                value = comment.use_smea;
                fieldKey = 'use_smea';
            }
            if (value != null && value !== '') {
                parameterLines.push(`${key}: ${toDisplayText(value)}`);
                parameterFields.push(`comment.${fieldKey}`);
            }
        });
        if (parameterLines.length > 0) {
            sections.push(createSectionModel(
                'novelaiParams', 'NovelAI Parameters', 'settings', false,
                parameterLines.join('\n'),
                { dataFields: parameterFields }
            ));
        }
        if (comment) {
            const rawComment = toDisplayText(comment);
            if (rawComment) {
                sections.push(createSectionModel(
                    'rawComment', 'Raw Comment', 'raw', false, rawComment,
                    { dataFields: ['raw_comment'] }
                ));
            }
        }

        if (sections.length === 0) {
            const fallback = fallbackEntries.find(entry => !isNegativeCaptionPath(entry.path));
            if (fallback) {
                sections.push(createSectionModel(
                    'positive', 'Base Prompt', 'positive', true, fallback.text,
                    { dataFields: [`comment.${fallback.path}`] }
                ));
            }
        }
        return sections;
    }

    return buildDescriptionSections(source, generatorName);
}

/**
 * セクション構築を例外なしで公開する。
 * @param {Object|null} metadata - 生のメタデータ
 * @returns {Array<Object>} - 表示セクション
 */
function buildSections(metadata) {
    try {
        return buildSectionsInternal(metadata);
    } catch (error) {
        const source = metadata && typeof metadata === 'object' ? metadata : {};
        try {
            return buildDescriptionSections(source, 'Unknown');
        } catch (fallbackError) {
            return [];
        }
    }
}

/**
 * A1111 の parameters 文字列を Grid 行へ変換する。
 * @param {*} parameters - parameters 文字列
 * @returns {Array<{key:string,value:string}>} - Grid 行
 */
function parseA1111Grid(parameters) {
    if (typeof parameters !== 'string') return [];
    const stepsIndex = parameters.indexOf('Steps:');
    if (stepsIndex < 0) return [];
    const parameterText = parameters.substring(stepsIndex).replace(/,\s*$/, '');
    return parameterText.split(/,\s*(?=[A-Za-z][^:]*:)/)
        .map(part => {
            const separator = part.indexOf(':');
            if (separator < 0) return null;
            const key = part.substring(0, separator).trim();
            let value = part.substring(separator + 1).trim();
            if (!key || !value) return null;
            if (key.toLowerCase() === 'size') value = value.replace(/\s*x\s*/i, ' × ');
            return { key, value };
        })
        .filter(Boolean);
}

/**
 * NovelAI Comment と画像サイズから Grid 行を作成する。
 * @param {Object} source - 生のメタデータ
 * @param {Object|null} comment - 解析済み Comment
 * @returns {Array<{key:string,value:string}>} - Grid 行
 */
function buildNovelAiGrid(source, comment) {
    const parsedComment = parseCommentObject(comment);
    if (!parsedComment) return [];
    const metadata = source && typeof source === 'object' ? source : {};
    const rows = [];
    const add = (key, value) => {
        const text = toDisplayText(value).trim();
        if (text) rows.push({ key, value: text });
    };
    const firstNonEmpty = (...values) => values.find(value => (
        value != null && (typeof value !== 'string' || value.trim() !== '')
    ));
    add('Model', firstNonEmpty(metadata.Source, parsedComment.source, parsedComment.model));
    add('Sampler', parsedComment.sampler);
    add('Steps', parsedComment.steps);
    add('Guidance', parsedComment.scale);
    add('Seed', parsedComment.seed);
    add('Strength', parsedComment.strength);
    add('Noise', parsedComment.noise);
    const smea = parsedComment.smea != null ? parsedComment.smea : parsedComment.use_smea;
    if (smea === true) add('SMEA', smea);
    const width = firstNonEmpty(metadata.width, metadata.Width, safeGet(metadata, 'IHDR.width'));
    const height = firstNonEmpty(metadata.height, metadata.Height, safeGet(metadata, 'IHDR.height'));
    if (width != null && height != null) add('Size', `${width} × ${height}`);
    return rows;
}

/**
 * ComfyUI の prompt JSON から主要なサンプラー情報を回収する。
 * @param {*} prompt - prompt JSON または JSON 文字列
 * @returns {Array<{key:string,value:string}>} - Grid 行
 */
function buildComfyGrid(prompt) {
    let parsed = prompt;
    if (typeof prompt === 'string') {
        try { parsed = JSON.parse(prompt); } catch (error) { return []; }
    }
    if (!parsed || typeof parsed !== 'object') return [];

    const rows = [];
    const seen = new Set();
    const supportedKeys = ['sampler_name', 'scheduler', 'steps', 'cfg', 'seed', 'noise_seed', 'ckpt_name'];
    const samplerNodeTypes = new Set(['KSampler', 'KSamplerAdvanced']);
    const visited = new Set();
    const maxDepth = 8;

    const addInputRows = inputs => {
        if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return;
        for (const key of supportedKeys) {
            const input = inputs[key];
            // 0 / false は有効値として残し、null と空文字だけを欠損扱いにする。
            if (seen.has(key) || input == null || input === '') continue;
            seen.add(key);
            rows.push({ key, value: toDisplayText(input) });
        }
    };

    const visit = (value, depth) => {
        if (depth > maxDepth || value == null || typeof value !== 'object' || visited.has(value)) return;
        visited.add(value);
        if (Array.isArray(value)) {
            value.forEach(item => visit(item, depth + 1));
            return;
        }

        if (samplerNodeTypes.has(value.class_type)) {
            addInputRows(value.inputs || value);
        }
        Object.values(value).forEach(child => {
            if (child && typeof child === 'object') visit(child, depth + 1);
        });
    };

    visit(parsed, 0);
    if (seen.has('seed') && seen.has('noise_seed')) {
        const noiseSeedIndex = rows.findIndex(row => row.key === 'noise_seed');
        if (noiseSeedIndex >= 0) rows.splice(noiseSeedIndex, 1);
    }
    return rows;
}

/**
 * メタデータから Generation Grid の行を作成する。
 * @param {Object|null} metadata - 生のメタデータ
 * @returns {Array<{key:string,value:string}>} - 空値を除いた Grid 行
 */
function buildGridInternal(metadata) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const generatorName = source.Comment ? 'NovelAI' : detectGenerator(source);
    if (['A1111', 'Civitai', 'Forge', 'Stable Diffusion WebUI'].includes(generatorName)) {
        const parameters = typeof source.parameters === 'string' && source.parameters.includes('Steps:')
            ? source.parameters
            : source.parameters_settings;
        return parseA1111Grid(parameters);
    }
    if (generatorName.startsWith('NovelAI')) {
        return buildNovelAiGrid(source, parseCommentObject(source.Comment));
    }
    if (generatorName === 'Tensor.art') {
        const parameters = typeof source.parameters === 'string' && source.parameters.includes('Steps:')
            ? source.parameters
            : source.parameters_settings;
        return parseA1111Grid(parameters);
    }
    if (generatorName === 'ComfyUI' || source.prompt || source.workflow || source.generation_data) {
        return buildComfyGrid(source.prompt);
    }
    if (generatorName.startsWith('Midjourney') && typeof source.Description === 'string') {
        const description = source.Description;
        const flagExpression = /--([A-Za-z][\w-]*)(?=[ \t]|$)/g;
        const flags = [];
        let match;

        while ((match = flagExpression.exec(description)) !== null) {
            flags.push({
                key: `--${match[1]}`,
                valueStart: flagExpression.lastIndex,
                index: match.index
            });
        }

        return flags.map((flag, index) => {
            const nextFlag = flags[index + 1];
            const valueEnd = nextFlag ? nextFlag.index : description.length;
            const value = description.substring(flag.valueStart, valueEnd).trim();
            return value ? { key: flag.key, value } : null;
        }).filter(Boolean);
    }
    return [];
}

/**
 * Generation Grid 構築を例外なしで公開する。
 * @param {Object|null} metadata - 生のメタデータ
 * @returns {Array<{key:string,value:string}>} - 空値を除いた Grid 行
 */
function buildGrid(metadata) {
    try {
        return buildGridInternal(metadata);
    } catch (error) {
        return [];
    }
}

/**
 * Modal Sectionの共有状態を管理するStoreを作成する。
 * @returns {{STORAGE_KEY:string,load:Function,normalize:Function,mergeAndSave:Function,getInitialState:Function}}
 */
const sectionStateStore = (() => {
    const STORAGE_KEY = 'modalSectionOpenStates';
    let lastValidMap = {};

    const cloneMap = source => {
        const clone = {};
        Object.keys(source).forEach(identifier => {
            Object.defineProperty(clone, identifier, {
                configurable: true,
                enumerable: true,
                value: source[identifier],
                writable: true
            });
        });
        return clone;
    };

    const isPlainObject = value => {
        if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
        try {
            const prototype = Object.getPrototypeOf(value);
            if (prototype === null) return true;
            if (Object.prototype.toString.call(value) !== '[object Object]') return false;
            return typeof prototype.constructor === 'function' &&
                prototype.constructor.name === 'Object';
        } catch (error) {
            return false;
        }
    };

    const normalize = value => {
        if (!isPlainObject(value)) return {};

        const normalized = {};
        try {
            Object.keys(value).forEach(identifier => {
                if (typeof identifier !== 'string' || identifier.length === 0 ||
                    typeof value[identifier] !== 'boolean') return;
                Object.defineProperty(normalized, identifier, {
                    configurable: true,
                    enumerable: true,
                    value: value[identifier],
                    writable: true
                });
            });
        } catch (error) {
            return {};
        }
        return normalized;
    };

    const getStorage = () => {
        try {
            if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync ||
                typeof chrome.storage.sync.get !== 'function') return null;
            return chrome.storage.sync;
        } catch (error) {
            return null;
        }
    };

    const callStorageMethod = (method, args) => new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
            if (settled) return;
            settled = true;
            callback(value);
        };
        const callback = value => {
            try {
                if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.lastError) {
                    finish(reject, new Error('Chrome storage operation failed'));
                    return;
                }
            } catch (error) {
                finish(reject, error);
                return;
            }
            finish(resolve, value);
        };

        try {
            const result = method(...args, callback);
            if (result && typeof result.then === 'function') {
                result.then(value => finish(resolve, value), error => finish(reject, error));
            } else if (result !== undefined || method.length <= args.length) {
                finish(resolve, result);
            }
        } catch (error) {
            finish(reject, error);
        }
    });

    const load = async () => {
        const storage = getStorage();
        if (!storage) return cloneMap(lastValidMap);

        try {
            const record = await callStorageMethod(storage.get.bind(storage), [STORAGE_KEY]);
            if (!isPlainObject(record) || !Object.prototype.hasOwnProperty.call(record, STORAGE_KEY)) {
                return cloneMap(lastValidMap);
            }
            const normalized = normalize(record[STORAGE_KEY]);
            if (!isPlainObject(record[STORAGE_KEY])) return cloneMap(lastValidMap);
            lastValidMap = normalized;
            return cloneMap(lastValidMap);
        } catch (error) {
            return cloneMap(lastValidMap);
        }
    };

    const mergeAndSave = async currentStates => {
        const normalizedSnapshot = normalize(currentStates);
        if (!isPlainObject(currentStates)) return false;

        const mergedMap = cloneMap(lastValidMap);
        Object.keys(normalizedSnapshot).forEach(identifier => {
            Object.defineProperty(mergedMap, identifier, {
                configurable: true,
                enumerable: true,
                value: normalizedSnapshot[identifier],
                writable: true
            });
        });

        const storage = getStorage();
        if (!storage || typeof storage.set !== 'function') return false;
        try {
            await callStorageMethod(storage.set.bind(storage), [{
                [STORAGE_KEY]: mergedMap
            }]);
            lastValidMap = mergedMap;
            return true;
        } catch (error) {
            return false;
        }
    };

    const getInitialState = (sectionId, existingDefault, loadedMap) => {
        if (typeof sectionId === 'string' && sectionId.length > 0 &&
            isPlainObject(loadedMap) &&
            Object.prototype.hasOwnProperty.call(loadedMap, sectionId) &&
            typeof loadedMap[sectionId] === 'boolean') {
            return loadedMap[sectionId];
        }
        return existingDefault;
    };

    return { STORAGE_KEY, load, normalize, mergeAndSave, getInitialState };
})();

if (typeof window !== 'undefined') window.sectionStateStore = sectionStateStore;

/**
 * セクションモデルを既存モーダル用の値へ変換する。
 * @param {Object} metadata - 生のメタデータ
 * @param {Array<Object>} sections - セクションモデル
 * @returns {{positive:string, negative:string, other:Object}} - 既存形式
 */
function sectionsToLegacyTabs(metadata, sections) {
    const source = metadata && typeof metadata === 'object' ? metadata : {};
    const positiveSection = sections.find(section => section.id === 'positive');
    const negativeSection = sections.find(section => section.id === 'negative');
    const other = { ...source };
    delete other.parameters;
    delete other.Description;
    if (positiveSection && positiveSection.name === 'Prompt' && source.prompt) delete other.prompt;
    const settingsSection = sections.find(section => section.id === 'genSettings');
    if (settingsSection) other.parameters_settings = settingsSection.text;
    return {
        positive: positiveSection ? positiveSection.text : '',
        negative: negativeSection ? negativeSection.text : '',
        other
    };
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
 * @returns {Promise<HTMLElement>} - モーダルオーバーレイ要素
 */
async function createModal(metadata, imageUrl = null) {
    let loadedSectionStates = {};
    try {
        loadedSectionStates = await sectionStateStore.load();
    } catch (error) {
        loadedSectionStates = {};
    }

    const sectionModel = buildSections(metadata);
    const gridRows = buildGrid(metadata);
    const generatorName = detectGenerator(metadata || {});
    const modalSettings = window.settings && typeof window.settings === 'object'
        ? window.settings
        : {};

    const existingOverlay = document.getElementById('ai-meta-modal-overlay');
    if (existingOverlay) {
        const existingClose = existingOverlay.closeModal;
        if (typeof existingClose === 'function') await existingClose();
        else existingOverlay.remove();
    }

    const overlay = document.createElement('div');
    overlay.id = 'ai-meta-modal-overlay';
    overlay.className = 'ai-meta-modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'ai-meta-modal';
    modal.style.width = (modalSettings.modalWidth || 600) + 'px';
    modal.style.height = (modalSettings.modalHeight || 500) + 'px';
    if (modalSettings.modalX === 'center' || modalSettings.modalY === 'center') {
        modal.style.left = '50%';
        modal.style.top = '50%';
        modal.style.transform = 'translate(-50%, -50%)';
    } else {
        modal.style.left = (typeof modalSettings.modalX === 'number' ? modalSettings.modalX : 100) + 'px';
        modal.style.top = (typeof modalSettings.modalY === 'number' ? modalSettings.modalY : 100) + 'px';
        modal.style.transform = 'none';
    }

    const header = document.createElement('div');
    header.className = 'ai-meta-modal-header';
    const title = document.createElement('h2');
    title.textContent = `Image Metadata - ${generatorName}`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ai-meta-close-btn';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    header.appendChild(title);
    header.appendChild(closeBtn);

    const content = document.createElement('div');
    content.className = 'ai-meta-modal-content';
    const collectSectionStates = () => {
        const states = {};
        content.querySelectorAll('.ai-meta-section[data-section-id]').forEach(section => {
            const sectionId = section.dataset.sectionId;
            if (typeof sectionId !== 'string' || sectionId.length === 0) return;
            Object.defineProperty(states, sectionId, {
                configurable: true,
                enumerable: true,
                value: !section.classList.contains('collapsed'),
                writable: true
            });
        });
        return states;
    };
    let closePromise = null;
    const closeModal = () => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
            try {
                await sectionStateStore.mergeAndSave(collectSectionStates());
            } catch (error) {
                // 保存失敗時もModalの終了処理は継続する。
            } finally {
                overlay.remove();
                document.removeEventListener('keydown', handleEsc);
            }
        })();
        return closePromise;
    };
    const handleEsc = event => {
        if (event.key === 'Escape') closeModal();
    };
    closeBtn.onclick = event => {
        event.stopPropagation();
        closeModal();
    };
    overlay.onclick = event => {
        if (event.target === overlay) closeModal();
    };
    overlay.closeModal = closeModal;
    document.addEventListener('keydown', handleEsc);

    const editingEnabled = typeof modalSettings.enableMetadataEditing === 'undefined' || modalSettings.enableMetadataEditing;
    const sectionOpenSettings = {
        negative: modalSettings.sectionDefaultOpenNegative,
        genSettings: modalSettings.sectionDefaultOpenGenSettings,
        charPrompts: modalSettings.sectionDefaultOpenCharPrompts,
        charUndesired: modalSettings.sectionDefaultOpenCharUndesired,
        novelaiParams: modalSettings.sectionDefaultOpenNovelaiParams,
        rawComment: modalSettings.sectionDefaultOpenRawComment,
        workflow: modalSettings.sectionDefaultOpenWorkflow,
        other: modalSettings.sectionDefaultOpenOther
    };
    const getInitialSectionState = (sectionId, modelDefaultOpen) => {
        const configuredDefaultOpen = sectionOpenSettings[sectionId];
        const existingDefaultOpen = typeof configuredDefaultOpen === 'boolean'
            ? configuredDefaultOpen
            : modelDefaultOpen;
        return sectionStateStore.getInitialState(
            sectionId,
            existingDefaultOpen,
            loadedSectionStates
        );
    };

    const countTags = text => String(text || '').split(/[,\n]/).map(tag => tag.trim()).filter(Boolean).length;
    const readAreaText = area => area ? (area.innerText || area.textContent || '') : '';

    const appendHighlightedText = (target, text) => {
        const pattern = /(Model:\s*[^,]+|ADetailer[^:]*:\s*[^,]+|Hires\s+(?:checkpoint|Module\s+\d+|CFG\s+Scale|upscale|steps|upscaler):\s*[^,]+|Lora\s+hashes:\s*(?:"[^"]+"|\{[^}]+\}|[^,]+))/gi;
        let cursor = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            if (match.index > cursor) target.appendChild(document.createTextNode(text.substring(cursor, match.index)));
            const span = document.createElement('span');
            span.textContent = match[0];
            if (/^Model:/i.test(match[0])) span.style.color = '#4a9eff';
            else if (/^ADetailer/i.test(match[0])) span.style.color = '#bb86fc';
            else if (/^Hires/i.test(match[0])) span.style.color = '#03dac6';
            else span.style.color = '#ffcb2b';
            span.style.fontWeight = 'bold';
            target.appendChild(span);
            cursor = pattern.lastIndex;
        }
        if (cursor < text.length) target.appendChild(document.createTextNode(text.substring(cursor)));
    };

    const createTextArea = (text, dataFields, highlight = false) => {
        const area = document.createElement('div');
        area.className = 'ai-meta-text-area';
        const displayText = toDisplayText(text);
        if (highlight && displayText) appendHighlightedText(area, displayText);
        else area.textContent = displayText || 'None';
        if (!displayText) area.classList.add('empty');
        if (Array.isArray(dataFields) && dataFields.length > 0) {
            area.setAttribute('data-field', dataFields.join(','));
        }
        if (editingEnabled) area.contentEditable = 'true';
        return area;
    };

    const renderSection = sectionModelItem => {
        const section = document.createElement('div');
        section.className = 'ai-meta-section';
        section.dataset.sectionId = sectionModelItem.id;
        const defaultOpen = getInitialSectionState(
            sectionModelItem.id,
            sectionModelItem.defaultOpen
        );
        if (!defaultOpen) section.classList.add('collapsed');

        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'ai-meta-section-header';
        sectionHeader.addEventListener('click', () => section.classList.toggle('collapsed'));

        const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        chevron.classList.add('ai-meta-chevron');
        chevron.setAttribute('viewBox', '0 0 12 12');
        chevron.setAttribute('width', '14');
        chevron.setAttribute('height', '14');
        chevron.setAttribute('aria-hidden', 'true');
        chevron.setAttribute('focusable', 'false');
        const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        chevronPath.setAttribute('d', 'M2 4.5 6 8l4-3.5');
        chevronPath.setAttribute('fill', 'none');
        chevronPath.setAttribute('stroke', 'currentColor');
        chevronPath.setAttribute('stroke-width', '1.5');
        chevronPath.setAttribute('stroke-linecap', 'round');
        chevronPath.setAttribute('stroke-linejoin', 'round');
        chevron.appendChild(chevronPath);
        sectionHeader.appendChild(chevron);

        const label = document.createElement('span');
        label.className = 'ai-meta-section-label';
        label.textContent = sectionModelItem.name;
        sectionHeader.appendChild(label);

        const values = sectionModelItem.children
            ? sectionModelItem.children.map(child => child.text).join('\n')
            : sectionModelItem.text;
        if (sectionModelItem.kind === 'positive' || sectionModelItem.kind === 'negative') {
            const tally = document.createElement('span');
            tally.className = 'ai-meta-section-tally';
            tally.textContent = String(countTags(values));
            sectionHeader.appendChild(tally);
        }

        const copyBtn = document.createElement('button');
        copyBtn.className = 'ai-meta-copy-btn';
        copyBtn.textContent = 'Copy';
        copyBtn.setAttribute('data-tooltip', 'Copy to clipboard');
        copyBtn.addEventListener('click', event => {
            event.stopPropagation();
            const areas = Array.from(section.querySelectorAll('.ai-meta-text-area'));
            copyToClipboard(areas.map(readAreaText).join('\n'), copyBtn);
        });
        sectionHeader.appendChild(copyBtn);

        const body = document.createElement('div');
        body.className = 'ai-meta-section-body';
        if (sectionModelItem.children && sectionModelItem.children.length > 0) {
            sectionModelItem.children.forEach(child => {
                const block = document.createElement('div');
                block.className = 'ai-meta-char-block';
                const childLabel = document.createElement('div');
                childLabel.className = 'ai-meta-char-label';
                childLabel.textContent = child.label;
                block.appendChild(childLabel);
                block.appendChild(createTextArea(child.text, child.dataFields));
                body.appendChild(block);
            });
        } else {
            body.appendChild(createTextArea(sectionModelItem.text, sectionModelItem.dataFields, sectionModelItem.highlight));
        }
        section.appendChild(sectionHeader);
        section.appendChild(body);
        return section;
    };

    const renderGrid = rows => {
        if (!Array.isArray(rows) || rows.length === 0) return null;
        const section = document.createElement('div');
        section.className = 'ai-meta-section ai-meta-grid';
        section.dataset.sectionId = 'grid';
        if (!getInitialSectionState('grid', true)) section.classList.add('collapsed');
        const sectionHeader = document.createElement('div');
        sectionHeader.className = 'ai-meta-section-header';
        sectionHeader.addEventListener('click', () => section.classList.toggle('collapsed'));
        const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        chevron.classList.add('ai-meta-chevron');
        chevron.setAttribute('viewBox', '0 0 12 12');
        chevron.setAttribute('width', '14');
        chevron.setAttribute('height', '14');
        chevron.setAttribute('aria-hidden', 'true');
        chevron.setAttribute('focusable', 'false');
        const chevronPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        chevronPath.setAttribute('d', 'M2 4.5 6 8l4-3.5');
        chevronPath.setAttribute('fill', 'none');
        chevronPath.setAttribute('stroke', 'currentColor');
        chevronPath.setAttribute('stroke-width', '1.5');
        chevronPath.setAttribute('stroke-linecap', 'round');
        chevronPath.setAttribute('stroke-linejoin', 'round');
        chevron.appendChild(chevronPath);
        sectionHeader.appendChild(chevron);
        const label = document.createElement('span');
        label.className = 'ai-meta-section-label';
        label.textContent = 'Generation Grid';
        sectionHeader.appendChild(label);
        section.appendChild(sectionHeader);
        const body = document.createElement('div');
        body.className = 'ai-meta-section-body ai-meta-grid-body';
        rows.forEach(row => {
            if (!row || row.key == null || row.key === '' ||
                row.value == null || row.value === '') return;
            const gridRow = document.createElement('div');
            gridRow.className = 'ai-meta-grid-row';
            const key = document.createElement('span');
            key.className = 'ai-meta-grid-key';
            key.textContent = row.key;
            const value = document.createElement('span');
            value.className = 'ai-meta-grid-val';
            value.textContent = row.value;
            value.dataset.gridValue = row.value;
            gridRow.appendChild(key);
            gridRow.appendChild(value);
            body.appendChild(gridRow);
        });
        section.appendChild(body);
        return section;
    };

    let gridInserted = false;
    const negativeIndexes = sectionModel
        .map((section, index) => ({ section, index }))
        .filter(({ section }) => section.id === 'negative' || section.id === 'charUndesired')
        .map(({ index }) => index);
    const lastNegativeIndex = negativeIndexes.length > 0
        ? negativeIndexes[negativeIndexes.length - 1]
        : -1;
    sectionModel.forEach((sectionModelItem, index) => {
        content.appendChild(renderSection(sectionModelItem));
        const shouldInsertGrid = lastNegativeIndex >= 0
            ? index === lastNegativeIndex
            : sectionModelItem.kind === 'positive';
        if (!gridInserted && shouldInsertGrid) {
            const grid = renderGrid(gridRows);
            if (grid) content.appendChild(grid);
            gridInserted = true;
        }
    });
    if (!gridInserted) {
        const grid = renderGrid(gridRows);
        if (grid) content.appendChild(grid);
    }

    const footer = document.createElement('div');
    footer.className = 'ai-meta-modal-footer';
    if (modalSettings.advancedModeEnabled && modalSettings.enableExperimentalWriting && imageUrl) {
        const writeBtn = document.createElement('button');
        writeBtn.className = 'ai-meta-copy-all-btn';
        writeBtn.textContent = 'Update & Download';
        writeBtn.style.backgroundColor = '#d32f2f';
        writeBtn.setAttribute('data-tooltip', '埋め込みメタデータを更新してダウンロード (PNG/WebP/JPEG対応、AVIFは非対応)');
        writeBtn.onclick = async event => {
            event.stopPropagation();
            const payload = {};
            content.querySelectorAll('.ai-meta-section:not(.ai-meta-grid)').forEach(section => {
                const label = section.querySelector('.ai-meta-section-label');
                const area = section.querySelector('.ai-meta-text-area');
                if (!label || !area) return;
                if (label.textContent === 'Positive Prompt') payload.positive = readAreaText(area);
                else if (label.textContent === 'Negative Prompt') payload.negative = readAreaText(area);
                else if (label.textContent === 'Other Settings') payload.other = readAreaText(area);
            });
            const hasStealthData = metadata && Object.keys(metadata).some(key => key.startsWith('Stealth PNG Info'));
            const warning = hasStealthData ? '\n\n⚠ この画像にはアルファチャンネルに隠されたステルスメタデータが含まれています。\n保存後もステルスデータは残ります。' : '';
            if (!window.confirm(`編集したメタデータで画像を再保存（ダウンロード）しますか？\n※元のファイルは変更されません。${warning}`)) return;
            writeBtn.disabled = true;
            writeBtn.textContent = 'Processing...';
            try {
                const response = await browserAPI.runtime.sendMessage({ action: 'writeMetadataAndDownload', imageUrl, metadata: payload });
                if (response && response.success) showNotification('Metadata updated and download started!');
                else throw new Error(response && response.error ? response.error : 'Failed to process image');
            } catch (error) {
                showNotification('Error: ' + error.message, 'error');
            } finally {
                writeBtn.disabled = false;
                writeBtn.textContent = 'Update & Download';
            }
        };
        footer.appendChild(writeBtn);
    }

    const copyAllBtn = document.createElement('button');
    copyAllBtn.className = 'ai-meta-copy-all-btn';
    copyAllBtn.textContent = 'Copy All Data';
    copyAllBtn.setAttribute('data-tooltip', 'Copy all metadata (raw format)');
    copyAllBtn.onclick = event => {
        event.stopPropagation();
        const text = Array.from(content.querySelectorAll('.ai-meta-section:not(.ai-meta-grid)')).map(section => {
            const label = section.querySelector('.ai-meta-section-label');
            const areas = Array.from(section.querySelectorAll('.ai-meta-text-area'));
            return `${label ? label.textContent : ''}:\n${areas.map(readAreaText).join('\n')}`;
        }).join('\n\n');
        copyToClipboard(text.trim(), copyAllBtn);
    };
    footer.appendChild(copyAllBtn);

    modal.appendChild(header);
    modal.appendChild(content);
    modal.appendChild(footer);
    overlay.appendChild(modal);
    initDragAndResize(modal, header);
    return overlay;
}

/**
 * モーダルのドラッグとリサイズ機能を初期化
 * @param {HTMLElement} modal - モーダル本体
 * @param {HTMLElement} header - ドラッグハンドルとなるヘッダー
 */
function initDragAndResize(modal, header) {
    let isDragging = false;
    let isResizing = false;
    let currentHandle = null;
    let startX, startY, startWidth, startHeight, startLeft, startTop;

    // リサイズハンドルの作成
    const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
    handles.forEach(dir => {
        const handle = document.createElement('div');
        handle.className = `ai-meta-resize-handle ai-meta-resize-${dir}`;
        handle.dataset.dir = dir;
        modal.appendChild(handle);

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            isResizing = true;
            currentHandle = dir;
            startX = e.clientX;
            startY = e.clientY;
            startWidth = modal.offsetWidth;
            startHeight = modal.offsetHeight;
            startLeft = modal.offsetLeft;
            startTop = modal.offsetTop;

            // 中央揃え解除
            modal.style.transform = 'none';
            modal.style.left = startLeft + 'px';
            modal.style.top = startTop + 'px';

            document.addEventListener('mousemove', handleMouseMove);
            document.addEventListener('mouseup', handleMouseUp);
        });
    });

    // ヘッダードラッグ
    header.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = modal.offsetLeft;
        startTop = modal.offsetTop;

        // 中央揃え解除
        modal.style.transform = 'none';
        modal.style.left = startLeft + 'px';
        modal.style.top = startTop + 'px';

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
        e.preventDefault();
    });

    function handleMouseMove(e) {
        if (isDragging) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            modal.style.left = (startLeft + dx) + 'px';
            modal.style.top = (startTop + dy) + 'px';
        } else if (isResizing) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            let newWidth = startWidth;
            let newHeight = startHeight;
            let newLeft = startLeft;
            let newTop = startTop;

            if (currentHandle.includes('e')) newWidth = startWidth + dx;
            if (currentHandle.includes('w')) {
                newWidth = startWidth - dx;
                newLeft = startLeft + dx;
            }
            if (currentHandle.includes('s')) newHeight = startHeight + dy;
            if (currentHandle.includes('n')) {
                newHeight = startHeight - dy;
                newTop = startTop + dy;
            }

            // 最小サイズ制約
            if (newWidth > 300) {
                modal.style.width = newWidth + 'px';
                modal.style.left = newLeft + 'px';
            }
            if (newHeight > 200) {
                modal.style.height = newHeight + 'px';
                modal.style.top = newTop + 'px';
            }
        }
    }

    function handleMouseUp() {
        if (isDragging || isResizing) {
            // 設定を保存
            saveWindowSettings(modal);
        }
        isDragging = false;
        isResizing = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
    }
}

/**
 * ウィンドウの位置とサイズを設定に保存
 * @param {HTMLElement} modal 
 */
function saveWindowSettings(modal) {
    const settingsUpdate = {
        modalWidth: modal.offsetWidth,
        modalHeight: modal.offsetHeight,
        modalX: modal.offsetLeft,
        modalY: modal.offsetTop
    };

    // グローバルなsettingsオブジェクトも更新
    Object.assign(settings, settingsUpdate);

    // Chrome Storageに保存
    if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.sync.set(settingsUpdate);
    }
}

/**
 * ヘルパークリップボードコピー
 */
async function copyToClipboard(text, button) {
    try {
        await navigator.clipboard.writeText(text);
        const originalText = button.textContent;
        button.textContent = 'Copied!';
        button.classList.add('copied');
        setTimeout(() => {
            button.textContent = originalText;
            button.classList.remove('copied');
        }, 2000);
    } catch (err) {
        console.error('Failed to copy:', err);
    }
}

/**
 * 通知表示 (UI内)
 */
function showNotification(message, type = 'success') {
    const notification = document.createElement('div');
    notification.className = 'ai-meta-error-notification'; // スタイル流用
    if (type === 'success') {
        notification.style.backgroundColor = '#2ea043';
    }
    notification.textContent = message;
    document.body.appendChild(notification);
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => notification.remove(), 500);
    }, 3000);
}

/**
 * ページ内ダウンローダー起動ボタンを作成
 * @returns {HTMLElement}
 */
function createDownloadButton() {
    const btn = document.createElement('div');
    btn.className = 'ai-meta-download-fab';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'white');
    svg.setAttribute('stroke-width', '2');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3');
    svg.appendChild(path);
    btn.appendChild(svg);
    btn.title = 'Download AI Images';

    // スタイル (JSで直接書いても良いがCSSの方が管理しやすい)
    // ここでは最低限だけ設定し、詳細はstyles.cssで
    btn.style.position = 'fixed';
    btn.style.bottom = '20px';
    btn.style.right = '20px';
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
    const headerTitle = document.createElement('h2');
    headerTitle.textContent = 'Select Images to Download';
    header.appendChild(headerTitle);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'ai-meta-close-btn';
    closeBtn.textContent = '×';

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
        if (settings.downloaderFolderMode === 'id_pageTitle') {
            path += '123456_Page Title (Sample)/';
        } else if (settings.downloaderFolderMode === 'pageTitle' && pageTitle) {
            path += pageTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, 20) + '.../';
        } else if (settings.downloaderFolderMode === 'domain' && domain) {
            path += domain + '/';
        }

        // 安全な要素操作に置き換え
        while (saveHint.firstChild) {
            saveHint.removeChild(saveHint.firstChild);
        }
        const textNode = document.createTextNode('Save path: ');
        const codeNode = document.createElement('code');
        codeNode.style.color = '#4a9eff';
        codeNode.textContent = path;
        saveHint.appendChild(textNode);
        saveHint.appendChild(codeNode);
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
        while (content.firstChild) {
            content.removeChild(content.firstChild);
        }

        // 設定を読み込み (settings_loader.js が window.settings をセットしている前提)
        const settings = window.settings || { minPixelCount: 0, minImageSize: 0 };
        const minPixels = Number(settings.minPixelCount) || 0;
        const minSize = Number(settings.minImageSize) || 0;

        const targets = images.filter(img => {
            // AI画像は常に表示
            if (img.isAI) return true;

            // onlyAI モードなら非AIは除外
            if (onlyAI && !img.isAI) return false;

            // 非AI画像の場合、サイズチェックを再適用 (アダプターで拾われた小さなアイコン等を除外するため)
            if (img.type === 'image' && img.width && img.height) {
                if (img.width * img.height < minPixels) return false;
                if (img.width < minSize || img.height < minSize) return false;
            }

            return true;
        });

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
