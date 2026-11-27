const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '../..');
const extensionDir = path.join(repoRoot, 'extension');

function loadRuntime() {
    const context = vm.createContext({
        console,
        Promise,
        Error,
        URL,
        Number,
        Object,
        Array,
        String,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
    });
    context.window = context;
    vm.runInContext(fs.readFileSync(path.join(extensionDir, 'content_runtime.js'), 'utf8'), context, {
        filename: 'content_runtime.js',
    });
    return context;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

test('SPA URL tracker uses <=100ms debounce and an 800ms safety interval', () => {
    const context = loadRuntime();
    assert.deepEqual({ ...context.SPA_URL_TRACKER_DEFAULTS }, {
        debounceMs: 100,
        safetyIntervalMs: 800,
    });

    let url = 'https://example.test/a';
    const changes = [];
    const timeouts = [];
    const intervals = [];
    const tracker = context.createSpaUrlTracker({
        getUrl: () => url,
        onChange: (next, previous) => changes.push([previous, next]),
        setTimeout: (fn, ms) => { timeouts.push({ fn, ms, cancelled: false }); return timeouts.length - 1; },
        clearTimeout: (id) => { if (timeouts[id]) timeouts[id].cancelled = true; },
        setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length - 1; },
        clearInterval: () => {},
    });
    tracker.start();
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].ms, 800);

    tracker.schedule();
    tracker.schedule();
    assert.equal(timeouts.length, 2);
    assert.equal(timeouts[0].cancelled, true);
    assert.equal(timeouts[1].ms, 100);

    url = 'https://example.test/b';
    timeouts[1].fn();
    assert.deepEqual(changes, [['https://example.test/a', 'https://example.test/b']]);
    assert.equal(tracker.check(), false);
});

test('excluded-site patterns keep anchors after wildcard escaping', () => {
    const context = loadRuntime();
    assert.equal(context.matchesExcludedSitePattern('127.0.0.1', '127.0.0.1', 'http://127.0.0.1:8765/'), true);
    assert.equal(context.matchesExcludedSitePattern('*.example.com', 'a.example.com', 'https://a.example.com/x'), true);
    assert.equal(context.matchesExcludedSitePattern('*.example.com', 'example.com', 'https://example.com/x'), false);
    assert.equal(context.matchesExcludedSitePattern('example?.com', 'example1.com', 'https://example1.com/x'), true);
    assert.equal(context.matchesExcludedSitePattern('example.com', 'notexample.com', 'https://notexample.com/x'), false);
});

test('lazy module client coalesces concurrent requests and retries after failure', async () => {
    const context = loadRuntime();
    const gate = deferred();
    let sendCount = 0;
    let ready = false;
    const client = context.createLazyModuleClient({
        moduleName: 'ui',
        sendMessage: async () => {
            sendCount += 1;
            return gate.promise;
        },
        isReady: () => ready,
    });

    const first = client.ensure();
    const second = client.ensure();
    await Promise.resolve();
    assert.equal(sendCount, 1);
    gate.resolve({ success: true });
    await Promise.all([first, second]);
    assert.equal(client.isLoaded(), true);
    assert.equal(sendCount, 1);
    await client.ensure();
    assert.equal(sendCount, 1);

    ready = false;
    let attempts = 0;
    const failing = context.createLazyModuleClient({
        moduleName: 'ui',
        sendMessage: async () => {
            attempts += 1;
            return attempts === 1 ? { success: false, error: 'navigation-mismatch' } : { success: true };
        },
        isReady: () => false,
    });
    await assert.rejects(failing.ensure(), /Lazy module injection failed/);
    assert.equal(failing.isLoaded(), false);
    await failing.ensure();
    assert.equal(failing.isLoaded(), true);
    assert.equal(attempts, 2);
});

test('lazy module client does not send when the injected ready flag is already set', async () => {
    const context = loadRuntime();
    let sendCount = 0;
    const client = context.createLazyModuleClient({
        moduleName: 'ui',
        sendMessage: async () => { sendCount += 1; return { success: true }; },
        isReady: () => true,
    });
    await client.ensure();
    assert.equal(sendCount, 0);
    assert.equal(client.isLoaded(), true);
});

test('ui guard ignores hash changes, aborts on path mismatch, and leaves readiness to ui.js', () => {
    function runGuard(href, expected) {
        const context = vm.createContext({ URL, console });
        context.window = context;
        context.location = { href };
        context.__aiMetaViewerExpectedLazyUrl = expected;
        vm.runInContext(fs.readFileSync(path.join(extensionDir, 'ui_guard.js'), 'utf8'), context, {
            filename: 'ui_guard.js',
        });
        return context;
    }

    const hashOnly = runGuard('https://example.test/page#new', 'https://example.test/page#old');
    assert.equal(hashOnly.__aiMetaViewerAbortUiModule, false);
    assert.equal(hashOnly.__aiMetaViewerUiModuleReady, false);

    const mismatch = runGuard('https://example.test/other', 'https://example.test/page');
    assert.equal(mismatch.__aiMetaViewerAbortUiModule, true);
    assert.equal(mismatch.__aiMetaViewerUiModuleReady, false);
});

test('manifest keeps only the resident files in the all-urls entry and makes adapters conditional', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
    assert.ok(manifest.permissions.includes('scripting'));
    assert.equal(manifest.content_scripts.length, 2);

    const always = manifest.content_scripts.find(entry => entry.matches.includes('<all_urls>'));
    assert.deepEqual(always.js, ['shared_diagnostics.js', 'settings_loader.js', 'content_runtime.js', 'badge_controller.js', 'content.js']);
    assert.deepEqual(always.css, ['styles.css']);
    assert.equal(always.run_at, 'document_start');
    assert.equal(always.all_frames, true);

    const conditional = manifest.content_scripts.find(entry => entry !== always);
    assert.deepEqual(conditional.js, ['adapters.js']);
    assert.equal(conditional.matches.includes('<all_urls>'), false);
    assert.ok(conditional.matches.some(pattern => pattern.includes('discord.com')));
    assert.ok(conditional.matches.some(pattern => pattern.includes('pixiv.net')));
    assert.ok(conditional.matches.some(pattern => pattern.includes('civitai.com')));
    assert.equal(conditional.run_at, always.run_at);
    assert.equal(conditional.all_frames, always.all_frames);

    for (const delayed of ['ui.js', 'comfyui_parser.js', 'adapters.js', 'scanner.js', 'scanner/core.js']) {
        assert.equal(always.js.includes(delayed), false, `${delayed} must not be resident`);
    }
});

test('content source no longer starts the 200ms URL poll and delegates injection to the SW', () => {
    const content = fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8');
    const runtime = fs.readFileSync(path.join(extensionDir, 'content_runtime.js'), 'utf8');
    const background = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
    const scanner = fs.readFileSync(path.join(extensionDir, 'scanner.js'), 'utf8');
    assert.equal(content.includes('setInterval(checkUrlChange, 200)'), false);
    assert.equal(content.includes('startSpaUrlPolling'), false);
    assert.match(runtime, /action: 'ensureModule'/);
    assert.match(background, /const LAZY_MODULE_FILES = Object\.freeze\(\{\s*ui:/);
    assert.match(background, /allFrames: true/);
    assert.match(background, /scannerFrameResults/);
    assert.match(scanner, /frameScanSessions/);
    assert.match(scanner, /__aiMetaViewerScannerLoaded/);
});

test('ui entry contains a navigation abort guard and scanner is all-frame aware', () => {
    const ui = fs.readFileSync(path.join(extensionDir, 'ui.js'), 'utf8');
    const guard = fs.readFileSync(path.join(extensionDir, 'ui_guard.js'), 'utf8');
    assert.match(ui, /__aiMetaViewerAbortUiModule === true/);
    assert.match(ui, /window\.observeVideoMetadata = observeVideoMetadata;/);
    assert.match(ui, /window\.observeGenericSafetensorsLinks = observeGenericSafetensorsLinks;/);
    assert.match(ui, /window\.__aiMetaViewerUiModuleReady = true;/);
    assert.match(guard, /__aiMetaViewerUiModuleReady = false;/);
    assert.match(guard, /expectedUrl !== actualUrl/);
});

test('the injected comfyui parser aborts silently instead of throwing', () => {
    const parserSource = fs.readFileSync(path.join(extensionDir, 'comfyui_parser.js'), 'utf8');
    const context = vm.createContext({ console });
    context.window = context;
    context.__aiMetaViewerAbortUiModule = true;
    // A throw from an injected file cannot be caught by the extension; it always
    // becomes an "Uncaught Error" in the page console.
    assert.doesNotThrow(() => vm.runInContext(parserSource, context, { filename: 'comfyui_parser.js' }));
    assert.equal(context.ComfyUIParser, undefined);

    context.__aiMetaViewerAbortUiModule = false;
    assert.doesNotThrow(() => vm.runInContext(parserSource, context, { filename: 'comfyui_parser.js' }));
    assert.equal(typeof context.ComfyUIParser.summarize, 'function');
});

test('lazy module client stops retrying a permanently failing page until the URL changes', async () => {
    const context = loadRuntime();
    assert.deepEqual(
        { ...context.LAZY_MODULE_RETRY_DEFAULTS },
        { maxConsecutiveFailures: 3, failureCooldownMs: 30000 }
    );

    let url = 'https://example.test/product';
    let clock = 0;
    let sendCount = 0;
    const client = context.createLazyModuleClient({
        moduleName: 'ui',
        sendMessage: async () => {
            sendCount += 1;
            return { success: false, error: 'navigation-mismatch' };
        },
        isReady: () => false,
        getUrl: () => url,
        now: () => clock,
    });

    // Three attempts are allowed, then the page is left alone.
    for (let attempt = 0; attempt < 3; attempt += 1) {
        await assert.rejects(client.ensure(), /Lazy module injection failed/);
    }
    assert.equal(sendCount, 3);
    assert.equal(client.failureCount(), 3);

    clock += 1000;
    await assert.rejects(client.ensure(), error => {
        assert.equal(error.code, 'lazy-module-injection-failed');
        assert.equal(error.suppressed, true);
        return true;
    });
    assert.equal(sendCount, 3, 'no further message while the cooldown holds');

    // A soft navigation is a new attempt budget.
    url = 'https://example.test/product?page=2';
    await assert.rejects(client.ensure(), /Lazy module injection failed/);
    assert.equal(sendCount, 4);
    assert.equal(client.failureCount(), 1);

    // The cooldown re-opens retries on the same URL after 30s.
    clock += 30000;
    await assert.rejects(client.ensure(), /Lazy module injection failed/);
    assert.equal(sendCount, 5);
});

test('the service worker checks the frame URL before injecting the UI files', () => {
    const background = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
    // The setter probe reads the real frame URL and the mismatch branch returns
    // before any file is injected (no ui_guard abort, no console error).
    const probeIndex = background.indexOf('const urlProbe = await chrome.scripting.executeScript');
    const injectIndex = background.indexOf('files: config.scripts');
    assert.ok(probeIndex > 0, 'URL probe must exist');
    assert.ok(injectIndex > probeIndex, 'files are injected only after the probe');
    assert.match(background, /window\.__aiMetaViewerAbortUiModule = actual !== expected;/);
    assert.match(background, /probedUrl !== expectedUrl/);
    assert.match(background, /error: 'navigation-mismatch'/);
    assert.match(background, /error: 'unsupported-frame-url'/);
    const mismatchIndex = background.indexOf("probedUrl !== expectedUrl");
    assert.ok(
        background.slice(mismatchIndex, injectIndex).includes('return { success: false, error: \'navigation-mismatch\' }'),
        'mismatch must return before injection'
    );
});
