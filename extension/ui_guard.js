// ui_guard.js - navigation guard for the lazy UI module.
// Injected immediately before ui.js by the service worker. On a hashless URL
// mismatch it aborts ui.js initialization without marking the module ready.
(function installUiGuard(globalObject) {
    'use strict';

    function hashless(value) {
        if (typeof value !== 'string') return '';
        const hashIndex = value.indexOf('#');
        return hashIndex === -1 ? value : value.slice(0, hashIndex);
    }

    const expectedUrl = hashless(globalObject.__aiMetaViewerExpectedLazyUrl);
    const actualUrl = hashless(globalObject.location && globalObject.location.href);
    if (!expectedUrl || !actualUrl || expectedUrl !== actualUrl) {
        globalObject.__aiMetaViewerAbortUiModule = true;
        globalObject.__aiMetaViewerUiModuleReady = false;
        return;
    }
    globalObject.__aiMetaViewerAbortUiModule = false;
    globalObject.__aiMetaViewerUiModuleReady = false;
})(typeof window !== 'undefined' ? window : globalThis);
