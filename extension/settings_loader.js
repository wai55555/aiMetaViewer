// settings_loader.js - Settings Management for Content Scripts

// デフォルト設定
window.DEFAULT_SETTINGS = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000, // 500x500
    minImageSize: 120, // リンク付き画像の最小サイズ
    showAnalyzingBadge: true,
    analyzeEverywhere: false,
    excludedSites: [],
    ignoredMetadataKeys: ['XML:com.adobe.xmp'],
    ignoredSoftware: ['Adobe Photoshop', 'Adobe ImageReady', 'Celsys Studio Tool', 'GIMP', 'Paint.NET'],
    // ウィンドウ配置設定
    modalWidth: 600,
    modalHeight: 500,
    modalX: 'center',
    modalY: 'center',
    // 編集・隠し機能設定
    enableMetadataEditing: false,   // メタデータの編集を許可
    advancedModeEnabled: false,
    enableExperimentalWriting: false,
    // スキャン機能設定
    disableScanner: false,          // ページスキャン機能（AIメタデータ検出画像の一覧表示・ダウンロード）の無効化
    // メタデータモーダルの初期開閉設定（Positive と Generation Grid は常時展開）
    sectionDefaultOpenNegative: false,
    sectionDefaultOpenGenSettings: false,
    sectionDefaultOpenCharPrompts: false,
    sectionDefaultOpenCharUndesired: false,
    sectionDefaultOpenNovelaiParams: false,
    sectionDefaultOpenRawComment: false,
    sectionDefaultOpenWorkflow: false,
    sectionDefaultOpenOther: false
};

// 現在の設定（グローバル変数として公開）
window.settings = { ...DEFAULT_SETTINGS };

// 設定読込前・読込中・読込失敗時は診断出力を許可しない。
let settingsLoadState = 'unknown';

const safeDiagnostic = (() => {
    const SAFE_DIAGNOSTIC_MAX_LENGTH = 240;
    const SAFE_DIAGNOSTIC_ENUMS = Object.freeze({
        category: Object.freeze([
            'acquisition', 'parser', 'scanner', 'message', 'cache', 'storage',
            'settings', 'fatal-initialization'
        ]),
        phase: Object.freeze([
            'background', 'content', 'settings', 'initialization', 'download'
        ]),
        errorType: Object.freeze([
            'timeout', 'abort', 'network', 'invalid-response', 'storage', 'import', 'unknown'
        ]),
        scannerStatus: Object.freeze([
            'detected', 'empty', 'failed', 'skipped', 'unknown'
        ]),
        scheme: Object.freeze(['file', 'http', 'https'])
    });


    function isSafeEnumValue(enumName, value) {
        return SAFE_DIAGNOSTIC_ENUMS[enumName].includes(value);
    }

    function readOwnProperty(value, key) {
        try {
            if (value !== null && value !== undefined &&
                Object.prototype.hasOwnProperty.call(value, key)) {
                return value[key];
            }
        } catch (_) {
            // getterやProxyの例外を診断処理へ伝播させない。
        }
        return undefined;
    }

    function markSafeDiagnosticField(diagnostic, key, value) {
        if (key === 'category' || key === 'phase' || key === 'errorType' ||
            key === 'scannerStatus' || key === 'scheme') {
            if (isSafeEnumValue(key, value)) diagnostic[key] = value;
            return;
        }

        if (key === 'status' && Number.isInteger(value) && value >= 100 && value <= 599) {
            diagnostic.status = value;
            return;
        }

        if ((key === 'bodyPresent' || key === 'retryable') && typeof value === 'boolean') {
            diagnostic[key] = value;
        }
    }

    function classifyErrorType(errorName) {
        if (typeof errorName !== 'string') return 'unknown';
        const normalized = errorName.toLowerCase();
        if (normalized === 'aborterror' || normalized === 'abort') return 'abort';
        if (normalized === 'timeouterror' || normalized === 'timeout') return 'timeout';
        if (normalized === 'networkerror' || normalized === 'network') return 'network';
        if (normalized === 'syntaxerror' || normalized === 'invalidresponse') return 'invalid-response';
        if (normalized === 'quotaerror' || normalized === 'storageerror') return 'storage';
        if (normalized === 'importerror') return 'import';
        return 'unknown';
    }

    function classifyString(value, diagnostic) {
        const normalized = value.toLowerCase();
        const categoryKeywords = [
            ['fatal-initialization', ['fatal-initialization', 'importscripts']],
            ['acquisition', ['acquisition', 'fetch', 'download', 'image']],
            ['parser', ['parser', 'metadata', 'format']],
            ['scanner', ['scanner', 'scan', 'candidate']],
            ['message', ['message', 'response', 'send']],
            ['cache', ['cache']],
            ['storage', ['storage']],
            ['settings', ['setting', 'wildcard', 'excluded']]
        ];

        for (const [category, keywords] of categoryKeywords) {
            if (keywords.some(keyword => normalized.includes(keyword))) {
                diagnostic.category = category;
                break;
            }
        }

        if (normalized.includes('background')) diagnostic.phase = 'background';
        else if (normalized.includes('content')) diagnostic.phase = 'content';
        else if (normalized.includes('initial')) diagnostic.phase = 'initialization';
        else if (normalized.includes('download')) diagnostic.phase = 'download';
        else if (normalized.includes('setting')) diagnostic.phase = 'settings';

        if (normalized.includes('timeout')) diagnostic.errorType = 'timeout';
        else if (normalized.includes('abort')) diagnostic.errorType = 'abort';
        else if (normalized.includes('network')) diagnostic.errorType = 'network';
        else if (normalized.includes('invalid') && normalized.includes('response')) {
            diagnostic.errorType = 'invalid-response';
        }

        if (/^file:\/\//i.test(value)) diagnostic.scheme = 'file';
        else if (/^https:\/\//i.test(value)) diagnostic.scheme = 'https';
        else if (/^http:\/\//i.test(value)) diagnostic.scheme = 'http';

        // 自由文は出力せず、URL・path・Data URL・秘密情報らしき入力はredactionだけ残す。
        if (/^(?:data|blob):/i.test(value) ||
            /(?:password|passwd|secret|token|authorization|cookie|api[_-]?key)/i.test(value) ||
            /(?:^[A-Z]:[\\/]|^\\\\|\/Users\/|\/home\/|\/var\/|\\AppData\\)/i.test(value) ||
            /^(?:https?|file):\/\//i.test(value)) {
            diagnostic.redacted = true;
        }
    }

    function mergeSafeDiagnosticArgument(diagnostic, value) {
        if (value === null || value === undefined) return;

        if (typeof value === 'string') {
            classifyString(value, diagnostic);
            return;
        }

        if (typeof value === 'number') {
            markSafeDiagnosticField(diagnostic, 'status', value);
            return;
        }

        if (typeof value === 'boolean') return;

        if (typeof value === 'object' || typeof value === 'function') {
            let errorLike = false;
            try {
                errorLike = value instanceof Error ||
                    (typeof value.name === 'string' &&
                        (typeof value.message === 'string' || typeof value.stack === 'string'));
            } catch (_) {
                diagnostic.redacted = true;
            }

            if (errorLike) {
                diagnostic.errorType = classifyErrorType(readOwnProperty(value, 'name'));
                diagnostic.redacted = true;
                return;
            }

            if (typeof URL !== 'undefined' && value instanceof URL) {
                const protocol = value.protocol.toLowerCase();
                if (protocol === 'file:') diagnostic.scheme = 'file';
                else if (protocol === 'http:') diagnostic.scheme = 'http';
                else if (protocol === 'https:') diagnostic.scheme = 'https';
                diagnostic.redacted = true;
                return;
            }

            if ((typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) ||
                (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value))) {
                diagnostic.redacted = true;
                return;
            }

            const sensitiveKeys = [
                'url', 'href', 'path', 'file', 'metadata', 'payload', 'data', 'bytes',
                'body', 'message', 'stack', 'secret', 'token', 'password', 'cookie',
                'authorization', 'apiKey', 'api_key'
            ];
            for (const key of sensitiveKeys) {
                if (readOwnProperty(value, key) !== undefined) diagnostic.redacted = true;
            }

            const allowlistedKeys = [
                'category', 'phase', 'errorType', 'status', 'bodyPresent',
                'scannerStatus', 'retryable', 'scheme'
            ];
            for (const key of allowlistedKeys) {
                markSafeDiagnosticField(diagnostic, key, readOwnProperty(value, key));
            }
            return;
        }

        diagnostic.redacted = true;
    }

    function toSafeDiagnostic(args) {
        const diagnostic = { redacted: false };
        for (const value of args) mergeSafeDiagnosticArgument(diagnostic, value);
        if (!diagnostic.errorType) diagnostic.errorType = 'unknown';
        return diagnostic;
    }

    function formatSafeDiagnostic(diagnostic) {
        const fields = [];
        const orderedKeys = [
            'category', 'phase', 'errorType', 'status', 'bodyPresent',
            'scannerStatus', 'retryable', 'scheme'
        ];

        for (const key of orderedKeys) {
            const value = diagnostic[key];
            if (value !== undefined &&
                (key === 'status' || key === 'bodyPresent' || key === 'retryable' ||
                    isSafeEnumValue(key, value))) {
                fields.push(`${key}=${value}`);
            }
        }
        fields.push(`redacted=${diagnostic.redacted === true}`);
        return `[SafeDiagnostic ${fields.join(' ')}]`.slice(0, SAFE_DIAGNOSTIC_MAX_LENGTH);
    }

    return { toSafeDiagnostic, formatSafeDiagnostic };
})();

/**
 * 設定を非同期で読み込む
 * @returns {Promise<Object>} 読み込まれた設定オブジェクト
 */
window.loadSettings = async function () {
    settingsLoadState = 'loading';
    try {
        const stored = await chrome.storage.sync.get(null); // すべての保存済み設定を取得
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
            throw new TypeError('Invalid settings storage result');
        }
        window.settings = { ...DEFAULT_SETTINGS, ...stored }; // デフォルト値に保存済み値を上書き
        settingsLoadState = 'ready';
        return window.settings;
    } catch (e) {
        settingsLoadState = 'failed';
        window.debugLog({
            category: 'storage',
            phase: 'settings',
            errorType: 'storage'
        });
        return window.settings;
    }
};

/**
 * 除外サイト判定
 * @returns {boolean}
 */
window.isExcludedUrl = function () {
    const currentUrl = window.location.href;
    const hostname = window.location.hostname;

    if (!window.settings.excludedSites) return false;

    for (const pattern of window.settings.excludedSites) {
        if (!pattern) continue;

        try {
            // ワイルドカード変換 (* -> .*, ? -> .)
            // 正規表現特殊文字をエスケープしてからワイルドカードを変換
            const regexStr = ('^' + pattern + '$')
                .replace(/[.+^${}()|[\]\\]/g, '\\$&') // 正規表現特殊文字をエスケープ
                .replace(/\*/g, '.*')  // * を .* に変換
                .replace(/\?/g, '.');  // ? を . に変換

            const regex = new RegExp(regexStr, 'i');
            if (regex.test(hostname) || regex.test(currentUrl)) {
                return true;
            }
        } catch (e) {
            window.debugLog({
                category: 'settings',
                phase: 'settings',
                errorType: 'invalid-response'
            });
        }
    }
    return false;
};

// 設定更新メッセージを受信してグローバル設定を更新
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    try {
        if (request.action === 'settingsUpdated' && request.settings && typeof request.settings === 'object') {
            window.settings = { ...window.DEFAULT_SETTINGS, ...window.settings, ...request.settings };
            window.debugLog({
                category: 'settings',
                phase: 'settings'
            });
        }
    } catch (_) {
        // 不正な設定オブジェクトやgetterの例外を通常ログへ出さず、境界へ渡す。
        window.debugLog({
            category: 'settings',
            phase: 'settings',
            errorType: 'unknown'
        });
    }
});

/**
 * デバッグ用ログ出力
 * 設定が正常に読み込まれ、debugModeがbooleanのtrueの場合だけ出力される
 */
window.debugLog = function (...args) {
    if (settingsLoadState !== 'ready' ||
        !window.settings || window.settings.debugMode !== true) {
        return;
    }

    const diagnostic = safeDiagnostic.toSafeDiagnostic(args);
    console.log(safeDiagnostic.formatSafeDiagnostic(diagnostic));
};
