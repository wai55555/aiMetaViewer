/*
 * Debug Level 1 / Level 2 exclusivity on the options page.
 *
 * Level 2 (forced full fetch) already contains everything Level 1
 * (full-detection debug) does, so the two checkboxes must never be on at the
 * same time: enabling Level 2 clears and disables Level 1, and enabling
 * Level 1 clears Level 2.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '../..');
const optionsSource = fs.readFileSync(path.join(REPO, 'extension/options.js'), 'utf8');
const optionsHtml = fs.readFileSync(path.join(REPO, 'extension/options.html'), 'utf8');
const jaLocale = JSON.parse(fs.readFileSync(path.join(REPO, 'extension/_locales/ja/messages.json'), 'utf8'));
const enLocale = JSON.parse(fs.readFileSync(path.join(REPO, 'extension/_locales/en/messages.json'), 'utf8'));

function checkbox() {
    return {
        checked: false,
        disabled: false,
        listeners: {},
        addEventListener(type, handler) {
            if (!this.listeners[type]) this.listeners[type] = [];
            this.listeners[type].push(handler);
        },
        fire(type) {
            (this.listeners[type] || []).forEach(handler => handler());
        },
        listenerCount(type) { return (this.listeners[type] || []).length; },
    };
}

function loadOptionsPage(elements, stored = {}) {
    const readyHandlers = [];
    const context = {
        console,
        setTimeout,
        clearTimeout,
        document: {
            getElementById: id => elements[id] || null,
            querySelectorAll: () => [],
            querySelector: () => null,
            addEventListener: (type, handler) => { if (type === 'DOMContentLoaded') readyHandlers.push(handler); },
        },
        chrome: {
            runtime: {
                getManifest: () => ({ version: '0.0.0-test' }),
                getURL: value => value,
                sendMessage: () => {},
                onMessage: { addListener: () => {} },
                lastError: null,
            },
            storage: {
                sync: { get: async () => stored, set: () => {} },
                local: { get: () => {}, set: () => {} },
                onChanged: { addListener: () => {} },
            },
            i18n: { getMessage: () => '' },
        },
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(optionsSource, context, { filename: 'options.js' });
    return { context, ready: () => readyHandlers.forEach(handler => handler()) };
}

function flush() {
    return new Promise(resolve => setTimeout(resolve, 5));
}

test('Level 2 wins when both levels are stored', () => {
    const { context } = loadOptionsPage({});
    assert.deepEqual(
        { ...context.normalizeDebugLevels({ debugAllDetections: true, debugForceFullFetch: true }) },
        { debugForceFullFetch: true, debugAllDetections: false }
    );
    assert.deepEqual(
        { ...context.normalizeDebugLevels({ debugAllDetections: true }) },
        { debugForceFullFetch: false, debugAllDetections: true }
    );
    assert.deepEqual(
        { ...context.normalizeDebugLevels({}) },
        { debugForceFullFetch: false, debugAllDetections: false }
    );
});

test('the checkboxes cannot both stay enabled', async () => {
    const level1 = checkbox();
    const level2 = checkbox();
    const page = loadOptionsPage({ debugAllDetections: level1, debugForceFullFetch: level2 });
    // Wired at load time, before (and independently of) the page init handler: an
    // exception elsewhere in the options page must not allow both levels on.
    assert.equal(level1.listenerCount('change'), 1, 'Level 1 is wired on load');
    assert.equal(level2.listenerCount('change'), 1, 'Level 2 is wired on load');

    page.ready();
    await flush();
    assert.equal(level1.listenerCount('change'), 1, 'wiring is idempotent');
    assert.equal(level2.listenerCount('change'), 1, 'wiring is idempotent');

    level1.checked = true;
    level1.fire('change');
    assert.equal(level2.checked, false, 'enabling Level 1 clears Level 2');
    assert.equal(level1.disabled, false);

    level2.checked = true;
    level2.fire('change');
    assert.equal(level1.checked, false, 'enabling Level 2 clears Level 1');
    assert.equal(level1.disabled, true, 'Level 1 is disabled while Level 2 is on');

    level2.checked = false;
    level2.fire('change');
    assert.equal(level1.disabled, false, 'Level 1 is selectable again');
});

test('the levels stay exclusive even when the page init handler never runs', async () => {
    const level1 = checkbox();
    const level2 = checkbox();
    // No DOMContentLoaded dispatch: only the load-time wiring exists.
    loadOptionsPage({ debugAllDetections: level1, debugForceFullFetch: level2 });

    level2.checked = true;
    level2.fire('change');
    assert.equal(level1.checked, false);
    assert.equal(level1.disabled, true);

    level1.checked = true;
    level1.fire('change');
    assert.equal(level2.checked, false, 'Level 1 wins when it is switched on directly');
    assert.equal(level1.disabled, false);
});

test('stored "both on" state is shown as Level 2 only', async () => {
    const level1 = { ...checkbox(), checked: true };
    const level2 = checkbox();
    const page = loadOptionsPage(
        { debugAllDetections: level1, debugForceFullFetch: level2 },
        { debugAllDetections: true, debugForceFullFetch: true }
    );
    page.ready();
    await flush();
    assert.equal(level2.checked, true);
    assert.equal(level1.checked, false);
    assert.equal(level1.disabled, true);
    page.ready();
    await flush();
    assert.equal(level2.checked, true, 'loadSettings keeps the normalized state');
    assert.equal(level1.checked, false);
});

test('the labels state the level and the exclusivity', () => {
    assert.equal(jaLocale.labelDebugAllDetections.message, '全検知デバッグを有効化 (Level 1)');
    assert.match(jaLocale.descDebugAllDetections.message, /Level 2/);
    assert.equal(enLocale.labelDebugAllDetections.message, 'Enable Full-Detection Debug (Level 1)');
    assert.match(enLocale.descDebugAllDetections.message, /cannot be enabled together/);
    // The static HTML fallback must match the locale text.
    assert.match(optionsHtml, /data-i18n="labelDebugAllDetections">Enable Full-Detection Debug \(Level 1\)</);
    assert.match(optionsHtml, /data-i18n="labelDebugForceFullFetch">Force Full Fetch \(Level 2\)</);
});
