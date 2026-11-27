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
        this.nodeType = 1;
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
    get firstChild() { return this.children.length > 0 ? this.children[0] : null; }
    // レイアウト値（スクロール判定用）。テストが必要に応じて上書きする。
    get scrollHeight() { return this._scrollHeight || 0; }
    get clientHeight() { return this._clientHeight || 0; }
    // 実 DOM と同じく、既にどこかに居るノードは移動する（複製しない）。
    _detach(node) {
        if (node.parentNode && typeof node.parentNode.removeChild === 'function') {
            node.parentNode.removeChild(node);
        }
        return node;
    }
    appendChild(node) { this._detach(node); node.parentNode = this; this.children.push(node); return node; }
    insertBefore(node, reference) {
        this._detach(node);
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

function assertOrder(container, expected, message) {
    assert.equal(container.children.length, expected.length, `${message} (length)`);
    expected.forEach((node, index) => {
        assert.equal(container.children[index], node, `${message} (index ${index})`);
    });
}

/**
 * 実際のモーダルと同じ順序で組み立てる: 結果セクションを本文の先頭に入れ、
 * フッター行（右寄せボタンが既にある）へ実行ボタンを mount する。
 */
function mountStealth(context, body, url, metadata, options = {}) {
    const block = context.window.createStealthSection(url, metadata);
    if (!block) return { block: null, footer: null, content: null, positive: null };
    const footer = new FakeNode('div');
    footer.appendChild(new FakeNode('button')); // 既存の "Copy All Data" 相当
    // 実際のモーダルと同じく、本文はスクロールコンテナで、既存セクションの
    // 後ろ（最下部）に stealth セクションが入る。
    const content = new FakeNode('div');
    content._scrollHeight = options.scrollHeight || 2000;
    content._clientHeight = options.clientHeight || 500;
    content.scrollTop = options.scrollTop || 0;
    const positive = new FakeNode('div');
    positive.className = 'ai-meta-section';
    content.appendChild(positive);
    content.appendChild(block.section);
    body.appendChild(content);
    block.mount(footer);
    return { block, footer, content, positive };
}

test('the section is hidden when the PNG has no stealth-capable layout', async () => {
    const { context, body, dispatch } = loadUi({
        probePngInfo: () => ({ success: true, format: 'not-png' }),
    });
    const { block, footer, content, positive } = mountStealth(context, body, 'https://example.com/a.png', {});
    await flush();
    assertOrder(content, [positive], 'only the other sections remain');
    assert.equal(footer.children.length, 1, 'no trigger is offered');
    assert.ok(block, 'the builder still returns a mounted block');
    assert.equal(dispatch.filter(call => call.action === 'probePngInfo').length, 1);
    assert.equal(dispatch.some(call => call.action === 'scanStealthMetadata'), false);
});

test('an eligible PNG offers the trigger in the footer and renders the result above', async () => {
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
    const { block, footer, content, positive } = mountStealth(
        context, body, 'https://example.com/b.png', { parameters: 'steps: 20' }, { scrollTop: 1500 }
    );
    await flush();

    // Until the check runs the section stays where it always was: at the bottom.
    assertOrder(content, [positive, block.section], 'section starts at the bottom');

    // The trigger sits at the start (left) of the footer row, not inside the body.
    const trigger = footer.children[0];
    assert.equal(footer.children.length, 2, 'trigger is prepended to the footer row');
    assert.ok(trigger, 'button is offered for alpha PNG');
    assert.match(trigger.textContent, /Check stealth metadata/);
    assert.equal(block.section.querySelector('button'), null, 'no button inside the section body');
    assert.equal(block.section.style.display, '', 'section is visible once the probe says eligible');

    trigger.click();
    await flush();
    await flush();

    assert.equal(dispatch.filter(call => call.action === 'scanStealthMetadata').length, 1);
    assertOrder(content, [block.section, positive], 'the result moves to the top');
    assert.equal(content.scrollTop, 0, 'and the body scrolls there');
    assert.match(block.section.textContent, /stealth payload/);
    assert.match(block.section.textContent, /Stealth PNG Info \(Alpha\)/);
    assert.equal(footer.children.length, 1, 'trigger is removed after a successful scan');
});

test('a failed scan keeps the trigger available for a retry', async () => {
    const { context, body } = loadUi({
        probePngInfo: () => ({ success: true, format: 'png', hasAlpha: true, stealthEligible: true }),
        scanStealthMetadata: () => ({ success: false }),
    });
    const { block, footer } = mountStealth(context, body, 'https://example.com/c.png', {});
    await flush();
    footer.children[0].click();
    await flush();
    await flush();
    assert.match(block.section.textContent, /Stealth scan failed/);
    const retry = footer.children[0];
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
    const first = mountStealth(context, body, url, {});
    await flush();
    first.footer.children[0].click();
    await flush();
    await flush();

    const probesAfterFirst = dispatch.filter(call => call.action === 'probePngInfo').length;
    const scansAfterFirst = dispatch.filter(call => call.action === 'scanStealthMetadata').length;

    const second = mountStealth(context, body, url, {});
    await flush();

    assertOrder(second.content, [second.block.section, second.positive], 'a known result opens at the top');
    assert.match(second.block.section.textContent, /cached payload/);
    assert.equal(second.footer.children.length, 1, 'no trigger once the result is known');
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

test('a failed PNG header probe is reported and can be retried', async () => {
    let probeCalls = 0;
    const { context, body, dispatch } = loadUi({
        probePngInfo: () => {
            probeCalls += 1;
            // A file:// image whose header cannot be read must not look identical
            // to a JPEG/GIF (which legitimately removes the section).
            return probeCalls === 1
                ? { success: false, errorType: 'unknown' }
                : {
                    success: true, format: 'png', colorType: 6, bitDepth: 8,
                    hasAlpha: true, hasRgb: true, stealthEligible: true,
                };
        },
    });
    const { block, footer, content, positive } = mountStealth(context, body, 'file:///C:/img/a.png', {});
    await flush();

    assertOrder(content, [block.section, positive], 'the reason is shown at the top');
    assert.match(block.section.textContent, /Could not read the PNG header/);
    const retry = footer.children[0];
    assert.equal(retry.textContent, 'Retry header check');

    retry.click();
    await flush();
    assert.doesNotMatch(block.section.textContent, /Could not read the PNG header/);
    assert.match(footer.children[0].textContent, /Check stealth metadata/);
    assert.equal(dispatch.filter(call => call.action === 'probePngInfo').length, 2);
    assert.equal(dispatch.some(call => call.action === 'scanStealthMetadata'), false);
});

test('the modal wires the result to the top and the trigger into the footer row', () => {
    // Placement is decided inside createModal (a 700-line DOM builder that this
    // file does not assemble), so pin the two call sites. The visual order is
    // checked in docs/stealth-on-demand-e2e.md step 1.3.
    assert.match(
        uiSource,
        /stealthBlock = createStealthSection\(imageUrl, metadata\);[\s\S]{0,200}content\.appendChild\(stealthBlock\.section\)/,
        'the section is appended last, i.e. where it always was'
    );
    assert.match(
        uiSource,
        /const promoteToTop = \(\) => \{[\s\S]{0,200}parent\.insertBefore\(section, parent\.firstChild\)/,
        'the section moves itself to the top when it has something to show'
    );
    assert.match(
        uiSource,
        /footer\.appendChild\(copyAllBtn\);\s*\n\s*if \(stealthBlock\) stealthBlock\.mount\(footer\);/,
        'the trigger is mounted into the footer after the other footer buttons'
    );
    // The footer is right-aligned, so the trigger pins itself to the left edge.
    assert.match(uiSource, /button\.style\.marginRight = 'auto';/);
});

test('pressing the trigger scrolls the body back to the top so the result is visible', async () => {
    const { context, body } = loadUi({
        probePngInfo: () => ({ success: true, format: 'png', hasAlpha: true, stealthEligible: true }),
        scanStealthMetadata: () => ({
            success: true,
            stealth: { key: 'Stealth PNG Info (Alpha)', value: 'scrolled payload', mode: 'Alpha', compressed: false },
        }),
    });
    // 長いプロンプトを下まで読んだ状態を再現する。
    const { block, footer, content, positive } = mountStealth(
        context, body, 'https://example.com/f.png', { parameters: 'steps: 20' }, { scrollTop: 1500 }
    );
    await flush();
    assert.equal(content.scrollTop, 1500, 'opening the modal does not jump');
    assertOrder(content, [positive, block.section], 'still at the bottom before the press');

    footer.children[0].click();
    assert.equal(content.scrollTop, 0, 'the press reveals the scanning status immediately');
    assertOrder(content, [block.section, positive], 'the press moves the section to the top');

    content.scrollTop = 1500; // 結果を待つ間に読み進めても、結果表示で戻る
    await flush();
    await flush();
    assert.match(block.section.textContent, /scrolled payload/);
    assert.equal(content.scrollTop, 0, 'the result is revealed without manual scrolling');
});
