const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ComfyUIParser = require('../../extension/comfyui_parser.js');

const repoRoot = path.resolve(__dirname, '../..');

test('metadata text is preserved as text and the modal renders it through textContent', () => {
    const uiSource = fs.readFileSync(path.join(repoRoot, 'extension/ui.js'), 'utf8');
    const context = { window: { ComfyUIParser }, console };
    vm.runInNewContext(`${uiSource}\nglobalThis.__uiApi = { buildSections };`, context);
    const htmlValue = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const sections = context.__uiApi.buildSections({ parameters: htmlValue });
    const positive = sections.find(section => section.id === 'positive');
    assert.ok(positive);
    assert.equal(positive.text.includes(htmlValue), true);
    assert.match(uiSource, /area\.textContent = displayText \|\| 'None';/);
    assert.equal(uiSource.includes('area.innerHTML'), false);
});

test('Phase 3 cache versions invalidate old PNG and non-PNG negative caches', () => {
    const background = fs.readFileSync(path.join(repoRoot, 'extension/background.js'), 'utf8');
    assert.match(background, /const PNG_SCANNER_CACHE_VERSION = 'png-scanner-v4';/);
    assert.match(background, /const PARSER_CACHE_VERSION = 'parser-v2';/);
});
