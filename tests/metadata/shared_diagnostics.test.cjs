const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.resolve(__dirname, '../..');

function loadShared() {
    const context = vm.createContext({ console, URL });
    context.globalThis = context;
    vm.runInContext(
        fs.readFileSync(path.join(repoRoot, 'extension/shared_diagnostics.js'), 'utf8'),
        context,
        { filename: 'shared_diagnostics.js' },
    );
    return context.SafeDiagnostics;
}

test('shared diagnostics redact URLs/secrets and keep safe fields', () => {
    const shared = loadShared();
    const diagnostic = { redacted: false };
    shared.classifyString('fetch image', diagnostic);
    assert.equal(diagnostic.category, 'acquisition');
    const urlDiagnostic = { redacted: false };
    shared.classifyString('https://example.test/a?token=secret', urlDiagnostic);
    assert.equal(urlDiagnostic.scheme, 'https');
    assert.equal(urlDiagnostic.redacted, true);

    const objectDiagnostic = { redacted: false };
    objectDiagnostic.category = 'parser';
    objectDiagnostic.phase = 'background';
    objectDiagnostic.errorType = 'import';
    const text = shared.formatSafeDiagnostic(objectDiagnostic, {
        orderedKeys: ['category', 'phase', 'errorType'],
        enums: {
            category: ['parser'],
            phase: ['background'],
            errorType: ['import'],
        },
    });
    assert.equal(text, '[SafeDiagnostic category=parser phase=background errorType=import redacted=false]');
});

test('shared diagnostics is loaded before settings/content and background imports it first', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'extension/manifest.json'), 'utf8'));
    const always = manifest.content_scripts.find(entry => entry.matches.includes('<all_urls>'));
    assert.equal(always.js[0], 'shared_diagnostics.js');

    const background = fs.readFileSync(path.join(repoRoot, 'extension/background.js'), 'utf8');
    assert.match(background, /importScripts\('shared_diagnostics\.js',/);
    const content = fs.readFileSync(path.join(repoRoot, 'extension/content.js'), 'utf8');
    const settings = fs.readFileSync(path.join(repoRoot, 'extension/settings_loader.js'), 'utf8');
    assert.match(content, /window\.SafeDiagnostics/);
    assert.match(settings, /window\.SafeDiagnostics/);
});
