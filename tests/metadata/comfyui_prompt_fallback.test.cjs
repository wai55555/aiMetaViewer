/*
 * ComfyUI prompt fallback / resolver-table regression tests.
 *
 * Scope of this suite:
 *  - the A1111 `parameters` fallback fires only when the graph resolves no
 *    prompt at all, and its origin is labelled in the UI sections
 *  - the table-driven text resolver is data, not code paths
 *  - unresolved conditioning slots are dropped to `unconnected` instead of
 *    being labelled with the wrong side
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
    summarize,
    parseA1111Parameters,
    registerTextResolver,
    resetTextResolvers,
} = require('../../extension/comfyui_parser.js');
const fixtures = require('./fixtures/comfyui_prompt_fixtures.cjs');

const repoRoot = path.resolve(__dirname, '../..');
const uiSource = fs.readFileSync(path.join(repoRoot, 'extension/ui.js'), 'utf8');
const ComfyUIParser = require(path.join(repoRoot, 'extension/comfyui_parser.js'));
const uiContext = { window: { ComfyUIParser }, console };
vm.runInNewContext(uiSource, uiContext);
const buildSections = uiContext.window.buildSections;

test('A1111 parameters are used only when the graph yields no prompt text', () => {
    const metadata = fixtures.sdpromptReaderOnlyMetadata();
    const result = summarize(metadata);
    assert.deepEqual(result.positive, []);
    assert.deepEqual(result.negative, []);
    assert.ok(result.fallback, 'fallback should be populated');
    assert.equal(result.fallback.source, 'parameters');
    assert.equal(result.fallback.format, 'a1111');
    assert.equal(result.fallback.reason, 'graph-prompts-unresolved');
    assert.equal(result.fallback.positive, fixtures.A1111_EXPECTED.positive);
    assert.equal(result.fallback.negative, fixtures.A1111_EXPECTED.negative);
    assert.equal(result.fallback.settings, fixtures.A1111_EXPECTED.settings);
});

test('parameters fallback sections state their origin and stay read-only', () => {
    const sections = buildSections(fixtures.sdpromptReaderOnlyMetadata());
    const byId = Object.fromEntries(sections.map(section => [section.id, section]));
    assert.ok(byId.comfyFallbackOrigin, 'origin note is shown');
    assert.match(byId.comfyFallbackOrigin.text, /A1111-format `parameters` carrier/);
    assert.equal(byId.comfyFallbackPositive.kind, 'positive');
    assert.equal(byId.comfyFallbackPositive.text, fixtures.A1111_EXPECTED.positive);
    assert.equal(byId.comfyFallbackPositive.editable, false);
    assert.equal(byId.comfyFallbackNegative.kind, 'negative');
    assert.equal(byId.comfyFallbackNegative.text, fixtures.A1111_EXPECTED.negative);
    assert.equal(byId.comfyFallbackNegative.editable, false);
    assert.equal(byId.comfySummaryPositive, undefined);
});

test('graph prompts win over the parameters carrier', () => {
    const metadata = fixtures.plainClipTextEncodeMetadata();
    metadata.parameters = fixtures.A1111_PARAMETERS;
    const result = summarize(metadata);
    assert.deepEqual(result.positive.map(entry => entry.text), ['masterpiece, 1girl, solo, beach']);
    assert.deepEqual(result.negative.map(entry => entry.text), ['bad quality, watermark, text']);
    assert.equal(result.fallback, null);

    const sections = buildSections(metadata);
    assert.ok(sections.some(section => section.id === 'comfySummaryPositive'));
    assert.equal(sections.some(section => section.id === 'comfyFallbackPositive'), false);
});

test('structured parameters payloads never trigger the A1111 fallback', () => {
    const result = summarize(fixtures.structuredParametersMetadata());
    assert.equal(result.positive.length, 0);
    assert.equal(result.negative.length, 0);
    assert.equal(result.fallback, null);
});

test('API-format loader slots come from the schema table, not link order', () => {
    const result = summarize(fixtures.efficientLoaderSlotMetadata());
    assert.deepEqual(result.positive.map(entry => entry.text), ['POSITIVE TEXT']);
    assert.deepEqual(result.negative.map(entry => entry.text), ['NEGATIVE TEXT']);
});

test('a loader without a slot schema leaves its prompts unlabelled', () => {
    const result = summarize(fixtures.unknownLoaderMetadata());
    assert.deepEqual(result.positive, []);
    assert.deepEqual(result.negative, []);
    assert.deepEqual(
        result.unconnected.map(entry => entry.text).sort(),
        ['NEGATIVE TEXT', 'POSITIVE TEXT']
    );
    const sections = buildSections(fixtures.unknownLoaderMetadata());
    assert.equal(sections.some(section => section.id === 'comfySummaryPositive'), false);
    assert.ok(sections.some(section => section.id === 'comfySummaryUnconnected'));
});

test('declared CONDITIONING+/- output slots resolve to the matching side', () => {
    const result = summarize({ workflow: {
        nodes: [
            { id: 1, type: 'CLIPTextEncode', title: 'Positive', widgets_values: ['POS TEXT'], inputs: [], outputs: [{ name: 'CONDITIONING', slot_index: 0 }] },
            { id: 2, type: 'CLIPTextEncode', title: 'Negative', widgets_values: ['NEG TEXT'], inputs: [], outputs: [{ name: 'CONDITIONING', slot_index: 0 }] },
            {
                id: 3,
                type: 'Efficient Loader',
                inputs: [{ name: 'positive', link: 1 }, { name: 'negative', link: 2 }],
                outputs: [
                    { name: 'MODEL', type: 'MODEL', slot_index: 0 },
                    { name: 'CONDITIONING+', type: 'CONDITIONING', slot_index: 1 },
                    { name: 'CONDITIONING-', type: 'CONDITIONING', slot_index: 2 },
                    { name: 'LATENT', type: 'LATENT', slot_index: 3 },
                ],
            },
            { id: 4, type: 'KSampler', widgets_values: [1, 'fixed', 20, 5, 'euler', 'normal', 1], inputs: [{ name: 'positive', link: 3 }, { name: 'negative', link: 4 }] },
            { id: 5, type: 'SaveImage', inputs: [{ name: 'images', link: 5 }] },
        ],
        links: [
            [1, 1, 0, 3, 0, 'CONDITIONING'],
            [2, 2, 0, 3, 1, 'CONDITIONING'],
            [3, 3, 1, 4, 0, 'CONDITIONING'],
            [4, 3, 2, 4, 1, 'CONDITIONING'],
            [5, 4, 0, 5, 0, 'IMAGE'],
        ],
    } });
    assert.deepEqual(result.positive.map(entry => entry.text), ['POS TEXT']);
    assert.deepEqual(result.negative.map(entry => entry.text), ['NEG TEXT']);
});

test('table keys are class_type strings, not Python class names', () => {
    const result = summarize({ prompt: {
        '1': { class_type: 'CLIPTextEncodeWithWeight //Inspire', inputs: { text: 'inspire text' } },
        '2': { class_type: 'CLIPTextEncodeSDXL+', inputs: { text: 'essentials text' } },
        '3': { class_type: 'CLIPTextEncodeSDXLSimplified', inputs: { text: 'python class name' } },
        '4': { class_type: 'KSampler', inputs: { seed: 1, positive: ['1', 0], negative: ['2', 0] } },
        '5': { class_type: 'SaveImage', inputs: { images: ['4', 0] } },
    } });
    assert.deepEqual(result.positive.map(entry => entry.text), ['inspire text']);
    assert.deepEqual(result.negative.map(entry => entry.text), ['essentials text']);
    // A Python class name is still caught by the TextEncode compatibility
    // shim, but it stays unlabelled (never positive/negative).
    assert.deepEqual(result.unconnected.map(entry => entry.text), ['python class name']);
});

test('the text resolver table is data: new node types plug in without code changes', () => {
    try {
        assert.equal(registerTextResolver('MyPromptNode', { fields: ['prompt_text', 'suffix'], join: ' ' }), true);
        const result = summarize({ prompt: {
            '1': { class_type: 'MyPromptNode', inputs: { prompt_text: 'hello world', suffix: 'from table' } },
            '2': { class_type: 'KSampler', inputs: { seed: 1, positive: ['1', 0] } },
            '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
        } });
        assert.deepEqual(result.positive.map(entry => entry.text), ['hello world from table']);
        assert.deepEqual(result.negative, []);
    } finally {
        resetTextResolvers();
    }
    // Built-ins must survive a reset.
    const result = summarize(fixtures.plainClipTextEncodeMetadata());
    assert.deepEqual(result.positive.map(entry => entry.text), ['masterpiece, 1girl, solo, beach']);
});

test('unregistered node types stay unresolved instead of being guessed', () => {
    const result = summarize({ prompt: {
        '1': { class_type: 'Mystery Prompt Node', inputs: { seed: 1 } },
        '2': { class_type: 'KSampler', inputs: { seed: 1, positive: ['1', 0] } },
        '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
    } });
    assert.deepEqual(result.positive, []);
    assert.deepEqual(result.negative, []);
    assert.deepEqual(result.unconnected, []);
});

test('encoder name variants outside the table keep their previous behaviour', () => {
    const result = summarize({ prompt: {
        '1': { class_type: 'smZ CLIPTextEncode', inputs: { text: 'smz prompt' } },
        '2': { class_type: 'CLIPTextEncode (NSP)', inputs: { text: 'nsp prompt' } },
        '3': { class_type: 'KSampler', inputs: { seed: 1, positive: ['1', 0], negative: ['2', 0] } },
        '4': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
    } });
    assert.deepEqual(result.positive.map(entry => entry.text), ['smz prompt']);
    assert.deepEqual(result.negative.map(entry => entry.text), ['nsp prompt']);
});

test('parseA1111Parameters handles the marker variants', () => {
    assert.equal(parseA1111Parameters('{"sui_image_params": {}}'), null);
    assert.equal(parseA1111Parameters('just a sentence'), null);
    assert.equal(parseA1111Parameters(''), null);
    assert.equal(parseA1111Parameters(null), null);

    const positiveOnly = parseA1111Parameters('a prompt\nSteps: 20, Sampler: euler, Seed: 1');
    assert.deepEqual(positiveOnly, {
        positive: 'a prompt',
        negative: '',
        settings: 'Steps: 20, Sampler: euler, Seed: 1',
    });

    const both = parseA1111Parameters('pos text\nNegative prompt: neg text\nSteps: 20, Seed: 1');
    assert.deepEqual(both, {
        positive: 'pos text',
        negative: 'neg text',
        settings: 'Steps: 20, Seed: 1',
    });
});
