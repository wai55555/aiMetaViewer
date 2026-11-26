// settings_loader.js - Settings Management for Content Scripts

// デフォルト設定
window.DEFAULT_SETTINGS = {
    debugMode: false,
    debugAllDetections: false,
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
            'acquisition', 'file-access', 'representation-mismatch', 'resource-limit',
            'scanner-failure', 'cancelled', 'parser', 'scanner', 'message', 'cache',
            'storage', 'settings', 'fatal-initialization', 'unknown'
        ]),
        phase: Object.freeze([
            'background', 'content', 'settings', 'initialization', 'download',
            'acquisition', 'scanner', 'unknown'
        ]),
        errorType: Object.freeze([
            'timeout', 'abort', 'network', 'invalid-response', 'storage', 'import', 'unknown'
        ]),
        scannerStatus: Object.freeze([
            'detected', 'empty', 'failed', 'skipped', 'complete', 'not-found',
            'invalid-png', 'resource-limit', 'scanner-failure', 'cancelled', 'unknown'
        ]),
        scheme: Object.freeze(['file', 'http', 'https'])
    });

    const shared = window.SafeDiagnostics;


    function markSafeDiagnosticField(diagnostic, key, value) {
        if (key === 'category' || key === 'phase' || key === 'errorType' ||
            key === 'scannerStatus' || key === 'scheme') {
            if (shared.isSafeEnumValue(SAFE_DIAGNOSTIC_ENUMS, key, value)) diagnostic[key] = value;
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

    function mergeSafeDiagnosticArgument(diagnostic, value) {
        if (value === null || value === undefined) return;

        if (typeof value === 'string') {
            shared.classifyString(value, diagnostic);
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
                const errorName = shared.readSafeProperty(value, 'name');
                const errorMessage = shared.readSafeProperty(value, 'message');
                const errorStack = shared.readSafeProperty(value, 'stack');
                errorLike = value instanceof Error ||
                    (typeof errorName === 'string' &&
                        (typeof errorMessage === 'string' || typeof errorStack === 'string'));
            } catch (_) {
                diagnostic.redacted = true;
            }

            if (errorLike) {
                diagnostic.errorType = shared.classifyErrorType(shared.readSafeProperty(value, 'name'));
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
                if (shared.readOwnProperty(value, key) !== undefined) diagnostic.redacted = true;
            }

            const allowlistedKeys = [
                'category', 'phase', 'errorType', 'status', 'bodyPresent',
                'scannerStatus', 'retryable', 'scheme'
            ];
            for (const key of allowlistedKeys) {
                markSafeDiagnosticField(diagnostic, key, shared.readOwnProperty(value, key));
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
        return shared.formatSafeDiagnostic(diagnostic, {
            orderedKeys: [
                'category', 'phase', 'errorType', 'status', 'bodyPresent',
                'scannerStatus', 'retryable', 'scheme'
            ],
            enums: SAFE_DIAGNOSTIC_ENUMS,
            trusted: true,
            maxLength: SAFE_DIAGNOSTIC_MAX_LENGTH
        });
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
        const diagnostic = safeDiagnostic.toSafeDiagnostic([{
            category: 'storage',
            phase: 'settings',
            errorType: 'storage'
        }]);
        if (window.settings && window.settings.debugMode === true) {
            console.log(safeDiagnostic.formatSafeDiagnostic(diagnostic));
        }
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
            if (typeof window.matchesExcludedSitePattern === 'function') {
                if (window.matchesExcludedSitePattern(pattern, hostname, currentUrl)) return true;
                continue;
            }
            // content_runtime.js が無い単体テスト向けのフォールバック。
            // ワイルドカード変換 (* -> .*, ? -> .)。アンカーは変換後に付ける。
            const regexStr = '^' + pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.') + '$';
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
