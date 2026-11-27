// content_runtime.js - shared runtime helpers for the resident content script.
// Classic script: exposes small factories used by content.js and unit tests.
(function installContentRuntime(globalObject) {
    'use strict';

    const SPA_URL_TRACKER_DEFAULTS = Object.freeze({
        debounceMs: 100,
        safetyIntervalMs: 800,
    });
    // 恒久的に失敗するページ（about:blank フレームやソフトナビゲーション直後など）で
    // バッジ操作のたびに注入を試み続けないための上限。
    // 同じ URL では maxConsecutiveFailures 回まで、その後は failureCooldownMs 経過で再開する。
    const LAZY_MODULE_RETRY_DEFAULTS = Object.freeze({
        maxConsecutiveFailures: 3,
        failureCooldownMs: 30000,
    });

    function getHashlessUrl(value) {
        if (typeof value !== 'string') return '';
        const hashIndex = value.indexOf('#');
        return hashIndex === -1 ? value : value.slice(0, hashIndex);
    }

    function matchesExcludedSitePattern(pattern, hostname, url) {
        if (typeof pattern !== 'string' || pattern.length === 0) return false;
        try {
            const patternRegex = pattern
                .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                .replace(/\*/g, '.*')
                .replace(/\?/g, '.');
            const regex = new RegExp(`^${patternRegex}$`, 'i');
            return regex.test(hostname) || regex.test(url);
        } catch (_) {
            return false;
        }
    }

    function createSpaUrlTracker(options = {}) {
        const getUrl = typeof options.getUrl === 'function' ? options.getUrl : () => globalObject.location.href;
        const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
        const setTimeoutFn = typeof options.setTimeout === 'function' ? options.setTimeout : globalObject.setTimeout.bind(globalObject);
        const clearTimeoutFn = typeof options.clearTimeout === 'function' ? options.clearTimeout : globalObject.clearTimeout.bind(globalObject);
        const setIntervalFn = typeof options.setInterval === 'function' ? options.setInterval : globalObject.setInterval.bind(globalObject);
        const clearIntervalFn = typeof options.clearInterval === 'function' ? options.clearInterval : globalObject.clearInterval.bind(globalObject);
        const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : SPA_URL_TRACKER_DEFAULTS.debounceMs;
        const safetyIntervalMs = Number.isFinite(options.safetyIntervalMs)
            ? options.safetyIntervalMs
            : SPA_URL_TRACKER_DEFAULTS.safetyIntervalMs;

        let lastUrl = getUrl();
        let debounceTimer = null;
        let safetyTimer = null;
        let stopped = false;

        function check() {
            if (stopped) return false;
            const currentUrl = getUrl();
            if (currentUrl === lastUrl) return false;
            const previousUrl = lastUrl;
            lastUrl = currentUrl;
            onChange(currentUrl, previousUrl);
            return true;
        }

        function schedule() {
            if (stopped) return;
            if (debounceTimer !== null) clearTimeoutFn(debounceTimer);
            debounceTimer = setTimeoutFn(() => {
                debounceTimer = null;
                check();
            }, debounceMs);
        }

        function start() {
            if (stopped || safetyTimer !== null) return api;
            safetyTimer = setIntervalFn(check, safetyIntervalMs);
            return api;
        }

        function stop() {
            stopped = true;
            if (debounceTimer !== null) {
                clearTimeoutFn(debounceTimer);
                debounceTimer = null;
            }
            if (safetyTimer !== null) {
                clearIntervalFn(safetyTimer);
                safetyTimer = null;
            }
        }

        const api = {
            start,
            stop,
            schedule,
            check,
            getLastUrl: () => lastUrl,
        };
        return api;
    }

    function createLazyModuleClient(options = {}) {
        const moduleName = typeof options.moduleName === 'string' ? options.moduleName : 'ui';
        const sendMessage = typeof options.sendMessage === 'function' ? options.sendMessage : async () => ({ success: false });
        const isReady = typeof options.isReady === 'function' ? options.isReady : () => false;
        const now = typeof options.now === 'function' ? options.now : () => Date.now();
        const getUrl = typeof options.getUrl === 'function'
            ? options.getUrl
            : () => (typeof globalObject.location?.href === 'string' ? globalObject.location.href : '');
        const maxConsecutiveFailures = Number.isFinite(options.maxConsecutiveFailures)
            ? Math.max(1, options.maxConsecutiveFailures)
            : LAZY_MODULE_RETRY_DEFAULTS.maxConsecutiveFailures;
        const failureCooldownMs = Number.isFinite(options.failureCooldownMs)
            ? Math.max(0, options.failureCooldownMs)
            : LAZY_MODULE_RETRY_DEFAULTS.failureCooldownMs;
        let loaded = false;
        let inFlight = null;
        let failures = 0;
        let lastFailureAt = 0;
        let failureUrl = getUrl();

        function injectionFailedError() {
            const error = new Error('Lazy module injection failed');
            error.code = 'lazy-module-injection-failed';
            return error;
        }

        // URL が変われば失敗回数を数え直す。同じ URL で上限に達したら
        // クールダウンが明けるまで注入要求を送らない。
        function retryAllowed() {
            const url = getUrl();
            if (url !== failureUrl) {
                failureUrl = url;
                failures = 0;
                lastFailureAt = 0;
            }
            if (failures < maxConsecutiveFailures) return true;
            return (now() - lastFailureAt) >= failureCooldownMs;
        }

        function ensure() {
            if (loaded || isReady()) {
                loaded = true;
                return Promise.resolve({ success: true, cached: true });
            }
            if (inFlight) return inFlight;
            if (!retryAllowed()) {
                const suppressed = injectionFailedError();
                suppressed.suppressed = true;
                return Promise.reject(suppressed);
            }
            inFlight = Promise.resolve()
                .then(() => sendMessage({ action: 'ensureModule', module: moduleName }))
                .then((response) => {
                    if (!response || response.success !== true) {
                        failures += 1;
                        lastFailureAt = now();
                        failureUrl = getUrl();
                        throw injectionFailedError();
                    }
                    loaded = true;
                    failures = 0;
                    lastFailureAt = 0;
                    return response;
                })
                .finally(() => {
                    inFlight = null;
                });
            return inFlight;
        }

        return {
            ensure,
            isLoaded: () => loaded || isReady(),
            failureCount: () => failures,
        };
    }

    globalObject.SPA_URL_TRACKER_DEFAULTS = SPA_URL_TRACKER_DEFAULTS;
    globalObject.LAZY_MODULE_RETRY_DEFAULTS = LAZY_MODULE_RETRY_DEFAULTS;
    globalObject.getHashlessUrl = getHashlessUrl;
    globalObject.matchesExcludedSitePattern = matchesExcludedSitePattern;
    globalObject.createSpaUrlTracker = createSpaUrlTracker;
    globalObject.createLazyModuleClient = createLazyModuleClient;
})(typeof window !== 'undefined' ? window : globalThis);
