/*
 * DOM-level tests for the metadata modal's on-demand Stealth section.
 *
 * The section is only offered for PNGs whose IHDR says alpha (or 8-bit RGB),
 * so the normal view pays nothing. Clicking it sends one background scan and
 * the result is memoised for the rest of the page session.
 *
 * jsdom is avoided on purpose: importing it costs seconds per run on this
 * repository's filesystem, while the section only needs a handful of DOM
 * primitives.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '../..');
const uiSource = fs.readFileSync(path.join(REPO, 'extension/ui.js'), 'utf8');

class FakeClassList {
    constructor() { this.set = new Set(); }
    add(...names) { names.forEach(name => name && this.set.add(name)); }
    remove(...names) { names.forEach(name => this.set.delete(name)); }
    contains(name) { return this.set.has(name); }
    toggle(name) {
        if (this.set.has(name)) { this.set.delete(name); return false; }
        this.set.add(name);
        return true;
    }
}

class FakeNode {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.classList = new FakeClassList();
        this.style = {};
        this.dataset = {};
        this.attributes = {};
        this.parentNode = null;
        this.listeners = new Map();
        this._text = '';
        this._className = '';
        this.disabled = false;
        this.onclick = null;
    }
    set className(value) {
        this._className = String(value);
        this.classList = new FakeClassList();
        this.classList.add(...String(value).split(/\s+/));
    }
    get className() { return this._className; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() {
        return this._text + this.children.map(child => child.textContent).join('');
    }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name]; }
    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }
    appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
    insertBefore(node, reference) {
        const index = this.children.indexOf(reference);
        node.parentNode = this;
        this.children.splice(index < 0 ? this.children.length : index, 0, node);
        return node;
    }
    removeChild(node) {
        const index = this.children.indexOf(node);
        if (index >= 0) this.children.splice(index, 1);
        node.parentNode = null;
        return node;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    click() { if (this.onclick) this.onclick({ stopPropagation() {}, preventDefault() {} }); }
    _walk(out = []) {
        out.push(this);
        this.children.forEach(child => child._walk(out));
        return out;
    }
    querySelector(selector) {
        const nodes = this._walk().slice(1);
        if (selector.startsWith('.')) return nodes.find(node => node.classList.contains(selector.slice(1))) || null;
        return nodes.find(node => node.tagName === selector) || null;
    }
}

/**
 * ui.js を最小限の DOM スタブ上で読み込み、chrome.runtime.sendMessage を差し替える。
 * @param {Object} handlers - action ごとの応答
 */
function loadUi(handlers) {
    const dispatch = [];
    const context = {
        console,
        setTimeout,
        clearTimeout,
        Promise,
        Map,
        Set,
        Object,
        Array,
        String,
        Number,
        Boolean,
        JSON,
        RegExp,
        Error,
        chrome: {
            runtime: {
                lastError: undefined,
                sendMessage(message, callback) {
                    dispatch.push(message);
                    const handler = handlers[message.action];
                    const response = handler ? handler(message) : { success: false };
                    setTimeout(() => callback(response), 0);
                },
            },
        },
    };
    const body = new FakeNode('body');
    context.document = { createElement: tag => new FakeNode(tag), body };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(uiSource, context, { filename: 'ui.js' });
    return { context, body, dispatch };
}

function flush() {
    return new Promise(resolve => setTimeout(resolve, 5));
}

test('the section is hidden when the PNG has no stealth-capable layout', async () => {
    const { context, body, dispatch } = loadUi({
        probePngInfo: () => ({ success: true, format: 'not-png' }),
    });
    const section = context.window.createStealthSection('https://example.com/a.png', {});
    body.appendChild(section);
    await flush();
    assert.equal(body.children.length, 0, 'section removes itself');
    assert.equal(dispatch.filter(call => call.action === 'probePngInfo').length, 1);
    assert.equal(dispatch.some(call => call.action === 'scanStealthMetadata'), false);
});

test('an eligible PNG shows a button and renders the scan result on click', async () => {
    const { context, body, dispatch } = loadUi({
        probePngInfo: () => ({
            success: true, format: 'png', colorType: 6, bitDepth: 8,
            hasAlpha: true, hasRgb: true, stealthEligible: true,
        }),
        scanStealthMetadata: () => ({
            success: true,
            stealth: {
                key: 'Stealth PNG Info (Alpha)',
                value: '{"prompt":"stealth payload"}',
                mode: 'Alpha',
                compressed: false,
            },
        }),
    });
    const section = context.window.createStealthSection('https://example.com/b.png', { parameters: 'steps: 20' });
    body.appendChild(section);
    await flush();

    const button = section.querySelector('button');
    assert.ok(button, 'button is offered for alpha PNG');
    assert.match(button.textContent, /Check stealth metadata/);

    button.click();
    await flush();
    await flush();

    assert.equal(dispatch.filter(call => call.action === 'scanStealthMetadata').length, 1);
    assert.match(section.textContent, /stealth payload/);
    assert.match(section.textContent, /Stealth PNG Info \(Alpha\)/);
    assert.equal(section.querySelector('button'), null, 'button is removed after a successful scan');
});

test('a failed scan keeps the button available for a retry', async () => {
    const { context, body } = loadUi({
        probePngInfo: () => ({ success: true, format: 'png', hasAlpha: true, stealthEligible: true }),
        scanStealthMetadata: () => ({ success: false }),
    });
    const section = context.window.createStealthSection('https://example.com/c.png', {});
    body.appendChild(section);
    await flush();
    section.querySelector('button').click();
    await flush();
    await flush();
    assert.match(section.textContent, /Stealth scan failed/);
    const retry = section.querySelector('button');
    assert.ok(retry);
    assert.equal(retry.disabled, false);
    assert.match(retry.textContent, /Retry/);
});

test('a second modal open reuses the cached result without rescanning', async () => {
    const { context, body, dispatch } = loadUi({
        probePngInfo: () => ({ success: true, format: 'png', hasAlpha: true, stealthEligible: true }),
        scanStealthMetadata: () => ({
            success: true,
            stealth: { key: 'Stealth PNG Info (Alpha)', value: 'cached payload', mode: 'Alpha', compressed: false },
        }),
    });
    const url = 'https://example.com/d.png';
    const first = context.window.createStealthSection(url, {});
    body.appendChild(first);
    await flush();
    first.querySelector('button').click();
    await flush();
    await flush();

    const probesAfterFirst = dispatch.filter(call => call.action === 'probePngInfo').length;
    const scansAfterFirst = dispatch.filter(call => call.action === 'scanStealthMetadata').length;

    const second = context.window.createStealthSection(url, {});
    body.appendChild(second);
    await flush();

    assert.match(second.textContent, /cached payload/);
    assert.equal(dispatch.filter(call => call.action === 'probePngInfo').length, probesAfterFirst);
    assert.equal(dispatch.filter(call => call.action === 'scanStealthMetadata').length, scansAfterFirst);
});

test('no section is offered when stealth metadata was already detected', () => {
    const { context } = loadUi({});
    const section = context.window.createStealthSection('https://example.com/e.png', {
        'Stealth PNG Info (Alpha)': '{"prompt":"already found"}',
    });
    assert.equal(section, null);
});
