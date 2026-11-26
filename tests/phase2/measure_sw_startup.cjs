/*
 * Phase 2 decision-gate measurement: Service Worker startup evaluation time.
 *
 * Run on Windows Node (the script launches the Playwright Chromium binary):
 *   node tests/phase2/measure_sw_startup.cjs
 *
 * Optional env:
 *   CHROME_PATH, BENCH_URL, BENCH_RUNS (default 6, first run discarded)
 *
 * The script creates temporary extension copies with instrumentation only.
 * No product file is modified.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const REPO = path.resolve(__dirname, '../..');
const EXT_SOURCE = path.join(REPO, 'extension');
const CHROME = process.env.CHROME_PATH || 'C:\\Users\\y\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe';
const BENCH_URL = process.env.BENCH_URL || 'http://127.0.0.1:8765/normal.html';
const RUNS = Number(process.env.BENCH_RUNS || 6);
const PORT_BASE = 9500;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function connect(url) {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const events = [];
    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.id && pending.has(msg.id)) {
            const entry = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
            else entry.resolve(msg.result);
        } else if (msg.method) {
            events.push(msg);
        }
    });
    const ready = new Promise((resolve) => ws.on('open', resolve));
    function send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const messageId = ++id;
            pending.set(messageId, { resolve, reject });
            ws.send(JSON.stringify({ id: messageId, method, params }));
        });
    }
    return { ws, ready, send, events };
}

async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    return response.json();
}

function instrumentBackground(source, mode) {
    const importLine = "    importScripts('pako.js', 'jszip.min.js', 'parser.js', 'video_parser.js', 'video_range_reader.js', 'png_metadata_scanner.js');";
    if (!source.includes(importLine)) throw new Error('importScripts line not found');
    let output = `let __benchStart = performance.now();\nlet __benchBeforeImports = 0;\nlet __benchAfterImports = 0;\n${source}`;
    if (mode === 'background-only') {
        output = output.replace(importLine, '    __benchAfterImports = performance.now();');
    } else {
        output = output.replace(importLine, `    __benchBeforeImports = performance.now();\n${importLine}\n    __benchAfterImports = performance.now();`);
    }
    output += `\n\nif (__benchBeforeImports === 0) __benchBeforeImports = __benchAfterImports;\nchrome.storage.local.set({\n    __swBench: {\n        total: performance.now() - __benchStart,\n        imports: __benchAfterImports - __benchBeforeImports,\n        background: __benchBeforeImports - __benchStart,\n    },\n});\n`;
    return output;
}

function prepareExtension(variant) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aimv-sw-${variant}-`));
    const ext = path.join(dir, 'extension');
    fs.cpSync(EXT_SOURCE, ext, { recursive: true });
    const backgroundPath = path.join(ext, 'background.js');
    const source = fs.readFileSync(backgroundPath, 'utf8');
    fs.writeFileSync(backgroundPath, instrumentBackground(source, variant === 'background-only' ? 'background-only' : 'current'));
    return { dir, ext };
}

async function runOnce(variant, runIndex) {
    const { dir, ext } = prepareExtension(variant);
    const profile = path.join(dir, 'profile');
    const port = PORT_BASE + runIndex * 10 + (variant === 'background-only' ? 1 : 0);
    let chromeErr = '';
    const chrome = spawn(CHROME, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--user-data-dir=${profile}`,
        `--disable-extensions-except=${ext}`,
        `--load-extension=${ext}`,
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=0.0.0.0',
        'about:blank',
    ], { stdio: 'ignore' });

    let pageConn = null;
    try {
        let targets = [];
        for (let attempt = 0; attempt < 50; attempt += 1) {
            try {
                targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
                if (targets.some((target) => target.type === 'page')) break;
            } catch (_) {}
            await sleep(100);
        }
        const page = targets.find((target) => target.type === 'page');
        if (!page) throw new Error('page target not found');

        pageConn = connect(page.webSocketDebuggerUrl);
        await pageConn.ready;
        await pageConn.send('Runtime.enable');
        await pageConn.send('Page.enable');
        await pageConn.send('Page.navigate', { url: BENCH_URL });

        let bench = null;
        for (let attempt = 0; attempt < 80; attempt += 1) {
            await sleep(100);
            const contexts = pageConn.events
                .filter((event) => event.method === 'Runtime.executionContextCreated')
                .map((event) => event.params.context);
            const isolated = contexts.find((context) => context.auxData?.type === 'isolated');
            if (!isolated) continue;
            try {
                const result = await pageConn.send('Runtime.evaluate', {
                    contextId: isolated.id,
                    expression: `new Promise(resolve => chrome.storage.local.get('__swBench', resolve))`,
                    awaitPromise: true,
                    returnByValue: true,
                });
                const value = result.result?.value?.__swBench;
                if (value && Number.isFinite(value.total)) {
                    bench = value;
                    break;
                }
            } catch (_) {}
        }
        if (!bench) {
            const contexts = pageConn.events
                .filter((event) => event.method === 'Runtime.executionContextCreated')
                .map((event) => `${event.params.context.name}:${event.params.context.auxData?.type}`);
            throw new Error(`sw benchmark value not found; contexts=${contexts.join(',')}; chromeErr=${chromeErr.slice(-1500)}`);
        }
        return {
            variant,
            run: runIndex,
            totalMs: Number(bench.total.toFixed(3)),
            importMs: Number(bench.imports.toFixed(3)),
            backgroundMs: Number(bench.background.toFixed(3)),
        };
    } finally {
        try {
            if (pageConn) {
                pageConn.ws.close();
            }
            const version = await fetchJson(`http://127.0.0.1:${port}/json/version`).catch(() => null);
            if (version?.webSocketDebuggerUrl) {
                const browser = connect(version.webSocketDebuggerUrl);
                await browser.ready;
                browser.ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
                await sleep(300);
                browser.ws.close();
            }
        } catch (_) {
            chrome.kill();
        }
        await sleep(300);
        try { chrome.kill(); } catch (_) {}
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

(async () => {
    const results = [];
    for (const variant of ['current', 'background-only']) {
        for (let run = 0; run < RUNS; run += 1) {
            const result = await runOnce(variant, run);
            results.push(result);
            console.error(`${variant} run ${run + 1}/${RUNS}: total=${result.totalMs} import=${result.importMs} background=${result.backgroundMs}`);
        }
    }
    const summary = {};
    for (const variant of ['current', 'background-only']) {
        const measured = results.filter((entry) => entry.variant === variant).slice(1);
        summary[variant] = {
            totalMs: median(measured.map((entry) => entry.totalMs)),
            importMs: median(measured.map((entry) => entry.importMs)),
            backgroundMs: median(measured.map((entry) => entry.backgroundMs)),
            samples: measured,
        };
    }
    summary.deltaTotalMs = Number((summary.current.totalMs - summary['background-only'].totalMs).toFixed(3));
    summary.deltaImportMs = Number((summary.current.importMs - summary['background-only'].importMs).toFixed(3));
    process.stdout.write(`${JSON.stringify({ node: process.version, benchUrl: BENCH_URL, runsPerVariant: RUNS, firstRunDiscarded: true, summary, allResults: results }, null, 2)}\n`);
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
