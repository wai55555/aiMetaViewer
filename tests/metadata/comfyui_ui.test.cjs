const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ComfyUIParser = require('../../extension/comfyui_parser.js');

const repoRoot = path.resolve(__dirname, '../..');
const uiSource = fs.readFileSync(path.join(repoRoot, 'extension/ui.js'), 'utf8');
const uiContext = { window: { ComfyUIParser }, console };
vm.runInNewContext(`${uiSource}\nglobalThis.__uiApi = { buildSections, buildGrid, detectGenerator };`, uiContext);

test('ComfyUI sections show normalized prompts and preserve complete raw JSON sections', () => {
    const metadata = {
        generator: 'ComfyUI',
        prompt: {
            '1': { class_type: 'CLIPTextEncode', inputs: { text: 'positive prompt' } },
            '2': { class_type: 'KSampler', inputs: { positive: ['1', 0], steps: 12 } },
            '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
        },
        workflow: { nodes: [{ id: 1, type: 'CLIPTextEncode', widgets_values: ['workflow prompt'], inputs: [] }] },
        parameters: 'Version: ComfyUI',
    };
    const sections = uiContext.__uiApi.buildSections(metadata);
    const summary = sections.find(section => section.id === 'comfySummaryPositive');
    const rawPrompt = sections.find(section => section.id === 'rawApiPrompt');
    const rawWorkflow = sections.find(section => section.id === 'workflow');
    assert.equal(summary.children[0].text, 'positive prompt');
    assert.notEqual(rawPrompt.id, 'positive');
    assert.equal(rawPrompt.name, 'Raw API Prompt JSON');
    assert.match(rawPrompt.text, /"class_type": "CLIPTextEncode"/);
    assert.equal(rawWorkflow.name, 'Raw Workflow JSON');
    assert.match(rawWorkflow.text, /"workflow prompt"/);
    assert.ok(uiContext.__uiApi.buildGrid(metadata).some(row => row.key === 'Steps' && row.value === '12'));
});

test('ComfyUI raw JSON strings are preserved exactly in their source sections', () => {
    const rawWorkflow = '{ "nodes" : [ { "id" : 1 } ] }\n';
    const sections = uiContext.__uiApi.buildSections({ generator: 'ComfyUI', workflow: rawWorkflow });
    assert.equal(sections.find(section => section.id === 'workflow').text, rawWorkflow);
});

test('API-only ComfyUI prompt graphs are identified and summarized', () => {
    const metadata = { prompt: {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'API-only prompt' } },
        '2': { class_type: 'KSampler', inputs: { positive: ['1', 0], steps: 18 } },
        '3': { class_type: 'SaveImage', inputs: { images: ['2', 0] } },
    } };
    const sections = uiContext.__uiApi.buildSections(metadata);
    assert.equal(uiContext.__uiApi.detectGenerator(metadata), 'ComfyUI');
    assert.equal(sections.find(section => section.id === 'comfySummaryPositive').children[0].text, 'API-only prompt');
    assert.ok(sections.some(section => section.id === 'rawApiPrompt' && section.name === 'Raw API Prompt JSON'));
});

test('limited workflow summaries explain that the raw JSON remains available', () => {
    const graph = {};
    const chainLength = 5000;
    const samplerCount = 500;
    graph.chain0 = { class_type: 'CLIPTextEncode', inputs: { text: 'bounded prompt' } };
    for (let index = 1; index < chainLength; index++) {
        graph[`chain${index}`] = { class_type: 'NoOp', inputs: { input: [`chain${index - 1}`, 0] } };
    }
    for (let index = 0; index < samplerCount; index++) {
        graph[`sampler${index}`] = {
            class_type: 'KSampler',
            inputs: {
                model: [index > 0 ? `sampler${index - 1}` : `chain${chainLength - 1}`, 0],
                positive: [`chain${chainLength - 1}`, 0],
                negative: [`chain${chainLength - 1}`, 0],
            },
        };
    }
    graph.output = { class_type: 'SaveImage', inputs: { images: [`sampler${samplerCount - 1}`, 0] } };
    const sections = uiContext.__uiApi.buildSections({ generator: 'ComfyUI', prompt: graph });
    assert.ok(sections.some(section => section.id === 'comfySummaryNotice'));
    assert.ok(sections.some(section => section.id === 'rawApiPrompt' && section.name === 'Raw API Prompt JSON'));
});

test('video modal disables editing and metadata-writing while image modal keeps the existing path', () => {
    assert.match(uiSource, /const editingEnabled = mediaType !== 'video' &&/);
    assert.match(uiSource, /if \(mediaType !== 'video' && modalSettings\.advancedModeEnabled/);
    assert.match(uiSource, /async function createModal\(metadata, imageUrl = null, options = \{\}\)/);
    const badgeSource = fs.readFileSync(path.join(repoRoot, 'extension/badge_controller.js'), 'utf8');
    assert.match(badgeSource, /createModal\(currentMetadata, badge\._originalUrl, \{ mediaType: badge\._mediaType \}\)/);
    assert.match(uiSource, /mediaType !== 'video' && modalSettings\.advancedModeEnabled/);
});
