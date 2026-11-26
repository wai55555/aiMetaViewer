// content_runtime.js - shared runtime helpers for the resident content script.
// Classic script: exposes small factories used by content.js and unit tests.
(function installContentRuntime(globalObject) {
    'use strict';

    const SPA_URL_TRACKER_DEFAULTS = Object.freeze({
        debounceMs: 100,
        safetyIntervalMs: 800,
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
        let loaded = false;
        let inFlight = null;

        function ensure() {
            if (loaded || isReady()) {
                loaded = true;
                return Promise.resolve({ success: true, cached: true });
            }
            if (inFlight) return inFlight;
            inFlight = Promise.resolve()
                .then(() => sendMessage({ action: 'ensureModule', module: moduleName }))
                .then((response) => {
                    if (!response || response.success !== true) {
                        const error = new Error('Lazy module injection failed');
                        error.code = 'lazy-module-injection-failed';
                        throw error;
                    }
                    loaded = true;
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
        };
    }

    globalObject.SPA_URL_TRACKER_DEFAULTS = SPA_URL_TRACKER_DEFAULTS;
    globalObject.getHashlessUrl = getHashlessUrl;
    globalObject.matchesExcludedSitePattern = matchesExcludedSitePattern;
    globalObject.createSpaUrlTracker = createSpaUrlTracker;
    globalObject.createLazyModuleClient = createLazyModuleClient;
})(typeof window !== 'undefined' ? window : globalThis);
