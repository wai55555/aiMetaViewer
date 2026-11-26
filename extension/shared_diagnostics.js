// shared_diagnostics.js - common safe-diagnostic helpers for SW and content scripts.
// Classic script: no module syntax, safe to load first in both environments.
(function installSafeDiagnostics(globalObject) {
    'use strict';

    const DEFAULT_MAX_LENGTH = 240;

    function readOwnProperty(value, key) {
        try {
            return value !== null && value !== undefined &&
                Object.prototype.hasOwnProperty.call(value, key)
                ? value[key]
                : undefined;
        } catch (_) {
            return undefined;
        }
    }

    function readSafeProperty(value, key) {
        try {
            return value !== null && value !== undefined ? value[key] : undefined;
        } catch (_) {
            return undefined;
        }
    }

    function isSafeEnumValue(enums, key, value) {
        return Boolean(enums && Array.isArray(enums[key]) && enums[key].includes(value));
    }

    function classifyErrorType(errorName) {
        if (typeof errorName !== 'string') return 'unknown';
        const normalized = errorName.toLowerCase();
        if (normalized.includes('abort')) return 'abort';
        if (normalized.includes('timeout') || normalized.includes('stall')) return 'timeout';
        if (normalized.includes('network')) return 'network';
        if (normalized.includes('syntax') || normalized.includes('invalid') || normalized.includes('response')) {
            return 'invalid-response';
        }
        if (normalized.includes('quota') || normalized.includes('storage')) return 'storage';
        if (normalized.includes('import')) return 'import';
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
            ['settings', ['setting', 'wildcard', 'excluded']],
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

        if (/^(?:data|blob):/i.test(value) ||
            /(?:password|passwd|secret|token|authorization|cookie|api[_-]?key)/i.test(value) ||
            /(?:^[A-Z]:[\\/]|^\\\\|\/Users\/|\/home\/|\/var\/|\\AppData\\)/i.test(value) ||
            /^(?:https?|file):\/\//i.test(value)) {
            diagnostic.redacted = true;
        }
    }

    function formatSafeDiagnostic(diagnostic, options = {}) {
        const orderedKeys = Array.isArray(options.orderedKeys) ? options.orderedKeys : [];
        const enums = options.enums || {};
        const validators = options.validators || {};
        const trusted = options.trusted === true;
        const omitUnknown = options.omitUnknown === true;
        const fields = [];
        for (const key of orderedKeys) {
            const value = diagnostic?.[key];
            if (value === undefined) continue;
            if (omitUnknown && value === 'unknown') continue;
            if (trusted) {
                fields.push(`${key}=${value}`);
                continue;
            }
            if (typeof validators[key] === 'function') {
                if (validators[key](value)) fields.push(`${key}=${value}`);
                continue;
            }
            if (key === 'status') {
                if (Number.isInteger(value) && value >= 100 && value <= 599) fields.push(`${key}=${value}`);
                continue;
            }
            if (key === 'bodyPresent' || key === 'retryable') {
                if (typeof value === 'boolean') fields.push(`${key}=${value}`);
                continue;
            }
            if (isSafeEnumValue(enums, key, value)) fields.push(`${key}=${value}`);
        }
        fields.push(`redacted=${diagnostic?.redacted === true}`);
        return `[SafeDiagnostic ${fields.join(' ')}]`.slice(0, options.maxLength || DEFAULT_MAX_LENGTH);
    }

    globalObject.SafeDiagnostics = Object.freeze({
        readOwnProperty,
        readSafeProperty,
        isSafeEnumValue,
        classifyErrorType,
        classifyString,
        formatSafeDiagnostic,
    });
})(typeof globalThis !== 'undefined' ? globalThis : self);
