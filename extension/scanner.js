/**
 * scanner.js - Entry Point (Phase 1 lazy-injected scanner)
 *
 * The Service Worker injects this file and its dependencies only when the
 * extension action starts a page scan. The guard keeps repeated injection in
 * the same frame from registering duplicate listeners. Scan results from
 * iframes are relayed to the top frame through the Service Worker.
 */
(function installScanner(globalObject) {
    'use strict';

    if (globalObject.__aiMetaViewerScannerLoaded === true) return;
    globalObject.__aiMetaViewerScannerLoaded = true;
    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;

    const FRAME_SCAN_RESULT_TIMEOUT_MS = 8000;
    const frameScanSessions = new Map();

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'scanPage') {
            const scanId = typeof request.scanId === 'string' ? request.scanId : null;
            // Create the top-frame session synchronously so an iframe result that
            // arrives before loadSettings() resolves is not lost.
            const session = isTopFrame() && scanId ? createFrameScanSession(request) : null;
            handleScanRequest(request, sendResponse, session);
            return true; // Keep channel open for async response
        }
        if (request.action === 'scannerFrameResults') {
            handleFrameScanResult(request);
            sendResponse({ success: true });
            return false;
        }
        return false;
    });

    function isTopFrame() {
        return window.self === window.top;
    }

    function getScanContext() {
        return {
            pageTitle: document.title,
            domain: window.location.hostname,
            url: window.location.href,
        };
    }

    async function getSettingsForScan() {
        return typeof loadSettings !== 'undefined' ? await loadSettings() : window.settings;
    }

    async function collectFrameScan(settings, scanId) {
        let result;
        try {
            result = await executeScan(settings);
        } catch (error) {
            result = { success: false, error: error.message, candidates: [] };
        }
        try {
            const pending = chrome.runtime.sendMessage({
                action: 'scannerFrameResults',
                scanId,
                success: result.success === true,
                error: result.error || null,
                candidates: Array.isArray(result.candidates) ? result.candidates : [],
                context: getScanContext(),
            });
            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
        } catch (_) {
            // The top frame may have navigated away; its session timeout handles it.
        }
        return result;
    }

    async function handleScanRequest(request, sendResponse, session = null) {
        try {
            const settings = await getSettingsForScan();
            if (settings?.disableScanner) {
                if (session) finishFrameScanSession(session, { cancelled: true });
                if (isTopFrame()) showNotification('Scanner is disabled in extension settings');
                sendResponse({ success: false, error: 'Scanner is disabled' });
                return;
            }

            const scanId = typeof request.scanId === 'string' ? request.scanId : null;
            if (!isTopFrame() &&
                typeof isExcludedUrl === 'function' && isExcludedUrl()) {
                if (scanId) {
                    try {
                        const pending = chrome.runtime.sendMessage({
                            action: 'scannerFrameResults',
                            scanId,
                            success: true,
                            error: null,
                            candidates: [],
                            context: getScanContext(),
                        });
                        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
                    } catch (_) {}
                }
                sendResponse({ success: false, error: 'Site excluded' });
                return;
            }
            if (!isTopFrame()) {
                if (!scanId) {
                    sendResponse({ success: false, error: 'Skipped: Frame is not top' });
                    return;
                }
                const result = await collectFrameScan(settings, scanId);
                sendResponse({
                    success: result.success === true,
                    count: Array.isArray(result.candidates) ? result.candidates.length : 0,
                    frame: true,
                });
                return;
            }

            if (!scanId) {
                await runLegacyTopFrameScan(settings, sendResponse);
                return;
            }
            await runTopFrameScan(request, settings, sendResponse, session);
        } catch (error) {
            if (session) finishFrameScanSession(session, { cancelled: true });
            console.error('[AI Meta Viewer] Scan error:', error);
            if (isTopFrame()) showNotification('Scan failed: ' + error.message);
            sendResponse({ success: false, error: error.message });
        }
    }

    function createFrameScanSession(request) {
        const expectedFrameIds = Array.isArray(request.frameIds)
            ? request.frameIds.filter(Number.isInteger)
            : [0];
        if (!expectedFrameIds.includes(0)) expectedFrameIds.push(0);
        const session = {
            scanId: request.scanId,
            expectedFrameIds: new Set(expectedFrameIds),
            results: new Map(),
            context: getScanContext(),
            overlayData: null,
            isCancelled: false,
            finished: false,
            timeout: null,
        };
        frameScanSessions.set(session.scanId, session);

        const overlayData = showScanningOverlay(0);
        session.overlayData = overlayData;
        const { overlay, cancelButton } = overlayData;
        cancelButton.addEventListener('click', () => {
            session.isCancelled = true;
            overlay.remove();
            finishFrameScanSession(session, { cancelled: true });
        });
        return session;
    }

    async function runTopFrameScan(request, settings, sendResponse, session = null) {
        if (!session) session = createFrameScanSession(request);
        const { updateProgress } = session.overlayData;

        try {
            const result = await executeScan(settings, () => session.isCancelled, updateProgress);
            if (session.finished) {
                sendResponse({ success: false, error: 'Scan cancelled' });
                return;
            }
            session.results.set(0, {
                candidates: Array.isArray(result.candidates) ? result.candidates : [],
                success: result.success === true,
                error: result.error || null,
                context: getScanContext(),
            });
            if (session.timeout === null) {
                session.timeout = setTimeout(() => {
                    if (!session.finished) finishFrameScanSession(session);
                }, FRAME_SCAN_RESULT_TIMEOUT_MS);
            }
            maybeFinishFrameScanSession(session);
            sendResponse({
                success: true,
                count: Array.isArray(result.candidates) ? result.candidates.length : 0,
                collected: true,
            });
        } catch (error) {
            session.results.set(0, {
                candidates: [],
                success: false,
                error: error.message,
                context: getScanContext(),
            });
            if (session.timeout === null) {
                session.timeout = setTimeout(() => {
                    if (!session.finished) finishFrameScanSession(session);
                }, FRAME_SCAN_RESULT_TIMEOUT_MS);
            }
            maybeFinishFrameScanSession(session);
            sendResponse({ success: false, error: error.message });
        }
    }

    function handleFrameScanResult(request) {
        if (!isTopFrame()) return;
        const session = frameScanSessions.get(request.scanId);
        if (!session || session.finished) return;
        if (!session.expectedFrameIds.has(request.frameId)) return;
        session.results.set(request.frameId, {
            candidates: Array.isArray(request.candidates) ? request.candidates : [],
            success: request.success === true,
            error: request.error || null,
            context: request.context && typeof request.context === 'object' ? request.context : {},
        });
        maybeFinishFrameScanSession(session);
    }

    function maybeFinishFrameScanSession(session) {
        if (session.finished) return;
        for (const frameId of session.expectedFrameIds) {
            if (!session.results.has(frameId)) return;
        }
        finishFrameScanSession(session);
    }

    function mergeFrameCandidates(session) {
        const seen = new Set();
        const merged = [];
        for (const result of session.results.values()) {
            for (const candidate of result.candidates) {
                if (!candidate || typeof candidate.url !== 'string' || candidate.url.length === 0) continue;
                const key = `${candidate.type || ''}\0${candidate.url}`;
                if (seen.has(key)) continue;
                seen.add(key);
                merged.push(candidate);
            }
        }
        return merged;
    }

    function finishFrameScanSession(session, options = {}) {
        if (session.finished) return;
        session.finished = true;
        if (session.timeout !== null) {
            clearTimeout(session.timeout);
            session.timeout = null;
        }
        frameScanSessions.delete(session.scanId);
        if (session.overlayData?.overlay?.isConnected) session.overlayData.overlay.remove();
        if (options.cancelled) return;

        const candidates = mergeFrameCandidates(session);
        if (candidates.length > 0) {
            displayScanResults(candidates, session.context);
        } else {
            showNotification('No AI-generated media found on this page.');
        }
    }

    async function runLegacyTopFrameScan(settings, sendResponse) {
        const overlayData = showScanningOverlay(0);
        const { overlay, updateProgress, cancelButton } = overlayData;
        let isCancelled = false;
        cancelButton.addEventListener('click', () => {
            isCancelled = true;
            overlay.remove();
        });

        const result = await executeScan(settings, () => isCancelled, updateProgress);
        if (isCancelled) {
            sendResponse({ success: false, error: 'Scan cancelled' });
            return;
        }
        overlay.remove();
        if (result.success && result.candidates.length > 0) {
            displayScanResults(result.candidates, getScanContext());
            sendResponse({ success: true, count: result.candidates.length });
        } else {
            showNotification(result.error || 'No media found');
            sendResponse({
                success: false,
                error: result.error,
                ...(result.retryable === true ? { retryable: true } : {}),
            });
        }
    }

    /**
     * Legacy entry point kept for manual/debug callers.
     */
    async function scanAllImages() {
        if (!isTopFrame()) return;
        const settings = await getSettingsForScan();
        if (settings?.disableScanner) return;
        const result = await executeScan(settings);
        if (result.success && result.candidates.length > 0) {
            displayScanResults(result.candidates, getScanContext());
        } else {
            showNotification(result.error || 'No media found');
        }
    }

    globalObject.scanAllImages = scanAllImages;
})(typeof window !== 'undefined' ? window : globalThis);
