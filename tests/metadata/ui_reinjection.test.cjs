const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '../..');
const uiSource = fs.readFileSync(path.join(repoRoot, 'extension/ui.js'), 'utf8');

test('aborted ui.js can be re-injected without lexical redeclaration and only marks ready at the end', () => {
    const context = vm.createContext({
        console,
        URL,
        TextDecoder,
        TextEncoder,
        Uint8Array,
        ArrayBuffer,
        DataView,
        Promise,
        Map,
        Set,
        Error,
        Date,
        JSON,
        Math,
        Number,
        String,
        Object,
        Array,
        RegExp,
        parseInt,
        parseFloat,
        Infinity,
        NaN,
        setTimeout,
        clearTimeout,
    });
    context.window = context;
    context.ComfyUIParser = {};
    context.__aiMetaViewerAbortUiModule = true;
    assert.throws(() => vm.runInContext(uiSource, context), /aborted by navigation guard/);
    assert.notEqual(context.__aiMetaViewerUiModuleReady, true);

    context.__aiMetaViewerAbortUiModule = false;
    assert.doesNotThrow(() => vm.runInContext(uiSource, context));
    assert.equal(typeof context.createModal, 'function');
    assert.equal(typeof context.observeVideoMetadata, 'function');
    assert.equal(typeof context.observeGenericSafetensorsLinks, 'function');
    assert.equal(context.__aiMetaViewerUiModuleReady, true);
});
