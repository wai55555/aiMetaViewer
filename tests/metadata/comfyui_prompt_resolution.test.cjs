/*
 * P0 text-resolution behaviour (catalogue §3.5 / §3.8 / §3.10 / §4.1).
 *
 * Covers the rules that turn a real ComfyUI graph into labelled prompts:
 *  - concatenation chains resolve in declaration order with the node's own delimiter
 *  - wildcard nodes prefer the expanded (populated) text
 *  - API-format loader slots come from the verified schema table
 *  - LoRA carriers that the old /LoraLoader/ regex missed
 *  - unknown STRING holders are adopted only through their known keys
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { summarize } = require('../../extension/comfyui_parser.js');
const fixtures = require('./fixtures/comfyui_prompt_fixtures.cjs');

test('JPS chain + Efficient Loader resolves the whole prompt', () => {
    const result = summarize(fixtures.jpsEfficientLoaderMetadata());
    assert.equal(result.positive.length, 1);
    assert.equal(result.negative.length, 1);
    assert.equal(result.fallback, null, 'the graph resolves, so parameters are not needed');

    const positive = result.positive[0].text;
    // 13 + 187 + (190 populated_text via 192), joined with the JPS "comma"
    // delimiter, in declaration order.
    assert.match(positive, /^masterpiece, best quality/);
    assert.match(positive, /\(artist_a:0\.45\),\(artist_b:0\.35\), living room,white sofa,curtains,plant,dutch angle, dutch angle,dynamic angle,foreshortening$/);
    assert.equal(positive.split(', ').length >= 3, true);
    assert.equal(result.negative[0].text.startsWith('bad quality,worst quality'), true);
    // Parts must be consumed, not reported again as unconnected.
    assert.deepEqual(result.unconnected, []);
});

test('wildcard nodes use the expanded text, not the template', () => {
    const result = summarize(fixtures.wildcardMetadata());
    assert.deepEqual(result.positive.map(entry => entry.text), ['artist_a, best quality, standing']);
    assert.equal(result.positive[0].text.includes('__artist__'), false);
});

test('wildcard nodes fall back to the template when nothing was populated', () => {
    const result = summarize({ prompt: {
        '1': { class_type: 'ImpactWildcardProcessor', inputs: { wildcard_text: '__artist__, standing', populated_text: '', mode: 'populate' } },
        '2': { class_type: 'KSampler', inputs: { seed: 1, positive: ['1', 0] } },
        '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
    } });
    assert.deepEqual(result.positive.map(entry => entry.text), ['__artist__, standing']);
});

test('concatenation chains keep order and the declared delimiter', () => {
    const result = summarize(fixtures.concatMetadata());
    const positives = result.positive.map(entry => entry.text);
    const negatives = result.negative.map(entry => entry.text);
    assert.ok(positives.includes('core A + core B'), 'core StringConcatenate keeps its literal delimiter');
    assert.ok(positives.includes('was A, was B, was C'), 'WAS Text Concatenate defaults to ", "');
    assert.ok(negatives.includes('join A join B'), 'KJ JoinStrings defaults to a space');
    assert.ok(negatives.includes('jps A jps B'), 'JPS named delimiter "space" resolves to " "');
});

test('concatenation from a single linked part resolves without extra separator', () => {
    const result = summarize({ prompt: {
        '1': { class_type: 'PrimitiveString', inputs: { value: 'only part' } },
        '2': { class_type: 'Text Concatenate (JPS)', inputs: { delimiter: 'comma', text1: ['1', 0], text2: ['3', 0] } },
        '3': { class_type: 'PrimitiveString', inputs: { value: '' } },
        '4': { class_type: 'KSampler', inputs: { seed: 1, positive: ['2', 0] } },
        '5': { class_type: 'SaveImage', inputs: { images: ['4', 0] } },
    } });
    assert.deepEqual(result.positive.map(entry => entry.text), ['only part']);
});

test('easy fullLoader exposes its prompts on the verified slots', () => {
    const result = summarize(fixtures.easyLoaderSlotMetadata());
    assert.deepEqual(result.positive.map(entry => entry.text), ['EASY POS']);
    assert.deepEqual(result.negative.map(entry => entry.text), ['EASY NEG']);
});

test('LoRA loaders keep only enabled, non-zero entries', () => {
    const result = summarize(fixtures.loraMetadata());
    const texts = result.loras.map(entry => entry.text);
    assert.ok(texts.includes('split.safetensors (model 0.6, clip 0.4)'), 'Power Lora strengthTwo maps to clip');
    assert.ok(texts.includes('single.safetensors (0.8)'), 'missing strengthTwo falls back to strength');
    assert.ok(texts.includes('stacked.safetensors (0.75)'), 'Lora Loader Stack pairs');
    assert.ok(texts.includes('eff_a.safetensors (0.5)'), 'LoRA Stacker simple mode');
    assert.ok(texts.includes('eff_b.safetensors (1)'), 'LoRA Stacker continues past a None row');
    assert.ok(texts.includes('eff_adv.safetensors (model 0.7, clip 0.3)'), 'LoRA Stacker advanced mode');
    assert.equal(texts.some(text => text.includes('off.safetensors')), false, 'on:false is skipped');
    assert.equal(texts.some(text => text.includes('zero.safetensors')), false, 'zero strength is skipped');
    assert.equal(texts.some(text => text.includes('skipped.safetensors')), false, 'zero strength pair is skipped');
    assert.equal(texts.some(text => text.includes('outside_count')), false, 'rows past lora_count are ignored');
    assert.equal(texts.filter(text => text.startsWith('split.')).length, 1, 'no duplicate rows');
});

test('LoRA grid rows stay deduplicated', () => {
    const result = summarize(fixtures.loraMetadata());
    const gridLoras = result.grid.filter(row => row.key === 'LoRA').map(row => row.value);
    assert.equal(new Set(gridLoras).size, gridLoras.length);
});

test('unknown STRING holders are adopted through known keys', () => {
    const result = summarize({ prompt: {
        '1': { class_type: 'Some Untracked String Node', inputs: { text: 'hello from an unknown node' } },
        '2': { class_type: 'KSampler', inputs: { seed: 1, positive: ['1', 0] } },
        '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
    } });
    assert.deepEqual(result.positive.map(entry => entry.text), ['hello from an unknown node']);
});

test('unknown nodes only carrying a link stay unresolved', () => {
    const result = summarize({ prompt: {
        '1': { class_type: 'Unknown Wrapper', inputs: { text: ['2', 0] } },
        '2': { class_type: 'Unknown Source', inputs: { foo: 'not a prompt key' } },
        '3': { class_type: 'KSampler', inputs: { seed: 1, positive: ['1', 0] } },
        '4': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
    } });
    assert.deepEqual(result.positive, []);
});

test('composed prompts are not reported twice as unconnected nodes', () => {
    const result = summarize(fixtures.concatMetadata());
    assert.deepEqual(result.unconnected, []);
});

test('bare NaN in an API prompt does not drop the graph', () => {
    const prompt = JSON.stringify({ units: NaN }).replace('null', 'NaN');
    const result = summarize({ prompt: `{
        "1": { "class_type": "CLIPTextEncode", "inputs": { "text": "prompt with nan sibling" } },
        "2": { "class_type": "MathExpression|pysssss", "inputs": { "a": NaN, "b": 0, "expression": "a/b" } },
        "3": { "class_type": "KSampler", "inputs": { "seed": 1, "positive": ["1", 0] } },
        "4": { "class_type": "SaveImage", "inputs": { "images": ["3", 0] } }
    }` });
    assert.deepEqual(result.positive.map(entry => entry.text), ['prompt with nan sibling']);
    assert.ok(prompt.includes('NaN'));
});

test('Infinity and -Infinity are tolerated as well', () => {
    const result = summarize({ prompt: `{
        "1": { "class_type": "PrimitiveString", "inputs": { "value": "infinity prompt" } },
        "2": { "class_type": "MathExpression|pysssss", "inputs": { "a": Infinity, "b": -Infinity } },
        "3": { "class_type": "KSampler", "inputs": { "seed": 1, "positive": ["1", 0] } },
        "4": { "class_type": "SaveImage", "inputs": { "images": ["3", 0] } }
    }` });
    assert.deepEqual(result.positive.map(entry => entry.text), ['infinity prompt']);
});

test('muted and bypassed UI nodes never supply prompts', () => {
    const workflow = {
        nodes: [
            { id: 1, type: 'CLIPTextEncode', mode: 4, widgets_values: ['bypassed prompt'], inputs: [], outputs: [{ name: 'CONDITIONING' }] },
            { id: 2, type: 'CLIPTextEncode', mode: 2, widgets_values: ['muted prompt'], inputs: [], outputs: [{ name: 'CONDITIONING' }] },
            { id: 3, type: 'CLIPTextEncode', mode: 0, widgets_values: ['active prompt'], inputs: [], outputs: [{ name: 'CONDITIONING' }] },
            { id: 4, type: 'KSampler', widgets_values: [1, 'fixed', 20, 5, 'euler', 'normal', 1], inputs: [{ name: 'positive', link: 3 }] },
            { id: 5, type: 'SaveImage', inputs: [{ name: 'images', link: 4 }] },
        ],
        links: [
            [3, 3, 0, 4, 0, 'CONDITIONING'],
            [4, 4, 0, 5, 0, 'IMAGE'],
        ],
    };
    const result = summarize({ workflow });
    assert.deepEqual(result.positive.map(entry => entry.text), ['active prompt']);
    assert.deepEqual(result.unconnected, []);
});

test('numeric widgets on unknown nodes are not mistaken for prompts', () => {
    const result = summarize({ prompt: {
        '1': { class_type: 'DF_Float', inputs: { value: 1.5 } },
        '2': { class_type: 'JWFloat', inputs: { value: '1.5' } },
        '3': { class_type: 'KSampler', inputs: { seed: 1, positive: ['1', 0] } },
        '4': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
    } });
    assert.deepEqual(result.positive, []);
    assert.deepEqual(result.unconnected, []);
});

test('the same LoRA behind several outputs is reported once', () => {
    const result = summarize({ prompt: {
        '1': { class_type: 'Power Lora Loader (rgthree)', inputs: { lora_1: { on: true, lora: 'shared.safetensors', strength: 0.5 } } },
        '2': { class_type: 'KSampler', inputs: { seed: 1, model: ['1', 0], positive: ['3', 0] } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'prompt' } },
        '4': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
        '5': { class_type: 'PreviewImage', inputs: { images: ['2', 0] } },
    } });
    assert.deepEqual(result.loras.map(entry => entry.text), ['shared.safetensors (0.5)']);
});
