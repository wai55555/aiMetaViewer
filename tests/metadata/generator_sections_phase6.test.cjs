const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ComfyUIParser = require('../../extension/comfyui_parser.js');

const repoRoot = path.resolve(__dirname, '../..');
const uiSource = fs.readFileSync(path.join(repoRoot, 'extension/ui.js'), 'utf8');
const context = { window: { ComfyUIParser }, console };
vm.runInNewContext(uiSource, context);
const { buildSections, buildGrid, detectGenerator } = {
    buildSections: context.window.buildSections,
    buildGrid: context.window.buildGrid,
    detectGenerator: context.window.detectGenerator,
};

test('InvokeAI invokeai_metadata is detected and split into prompt/settings sections', () => {
    const payload = {
        positive_prompt: 'invoke positive',
        negative_prompt: 'invoke negative',
        steps: 30,
        cfg_scale: 6.5,
        scheduler: 'euler',
        seed: 12345,
        width: 512,
        height: 768,
        model: { model_name: 'invoke-model' },
    };
    const metadata = { invokeai_metadata: JSON.stringify(payload) };
    assert.equal(detectGenerator(metadata), 'InvokeAI');
    const sections = buildSections(metadata);
    assert.equal(sections.find(section => section.id === 'positive').text, 'invoke positive');
    assert.equal(sections.find(section => section.id === 'negative').text, 'invoke negative');
    const grid = buildGrid(metadata);
    assert.ok(grid.some(row => row.key === 'Steps' && row.value === '30'));
    assert.ok(grid.some(row => row.key === 'CFG scale' && row.value === '6.5'));
    assert.ok(grid.some(row => row.key === 'Sampler' && row.value === 'euler'));
    assert.ok(grid.some(row => row.key === 'Seed' && row.value === '12345'));
    assert.ok(grid.some(row => row.key === 'Size' && row.value === '512x768'));
    assert.ok(grid.some(row => row.key === 'Model' && row.value === 'invoke-model'));
});

test('InvokeAI prompt fallback and legacy sd-metadata image payload are supported', () => {
    const metadata = { 'sd-metadata': JSON.stringify({ image: { prompt: 'legacy invoke prompt' } }) };
    assert.equal(detectGenerator(metadata), 'InvokeAI');
    const sections = buildSections(metadata);
    assert.equal(sections.find(section => section.id === 'positive').text, 'legacy invoke prompt');

    const promptFallback = buildSections({ invokeai_metadata: JSON.stringify({ prompt: 'plain invoke prompt' }) });
    assert.equal(promptFallback.find(section => section.id === 'positive').text, 'plain invoke prompt');
});

test('SwarmUI sui_image_params is detected and split into prompt/settings sections', () => {
    const payload = {
        prompt: 'swarm positive',
        negativeprompt: 'swarm negative',
        steps: 20,
        sampler: 'dpmpp_2m',
        scheduler: 'karras',
        cfgscale: 7,
        seed: 9876,
        width: 1024,
        height: 1024,
        model: 'swarm-model',
        aspectratio: '1:1',
        swarm_version: '1.2.3',
        loras: ['style-a', 'style-b'],
        loraweights: [0.8, 0.5],
    };
    const metadata = { sui_image_params: JSON.stringify({ sui_image_params: payload }) };
    assert.equal(detectGenerator(metadata), 'SwarmUI');
    const sections = buildSections(metadata);
    assert.equal(sections.find(section => section.id === 'positive').text, 'swarm positive');
    assert.equal(sections.find(section => section.id === 'negative').text, 'swarm negative');
    const grid = buildGrid(metadata);
    assert.ok(grid.some(row => row.key === 'Steps' && row.value === '20'));
    assert.ok(grid.some(row => row.key === 'Sampler' && row.value === 'dpmpp_2m'));
    assert.ok(grid.some(row => row.key === 'Schedule type' && row.value === 'karras'));
    assert.ok(grid.some(row => row.key === 'CFG scale' && row.value === '7'));
    assert.ok(grid.some(row => row.key === 'LoRAs' && row.value === 'style-a:0.8, style-b:0.5'));
    assert.ok(grid.some(row => row.key === 'SwarmUI version' && row.value === '1.2.3'));

    const underscored = buildSections({
        sui_image_params: JSON.stringify({ sui_image_params: { prompt: 'p', negative_prompt: 'n' } }),
    });
    assert.equal(underscored.find(section => section.id === 'negative').text, 'n');
});

test('invalid InvokeAI/SwarmUI JSON falls back to Other without throwing', () => {
    for (const metadata of [
        { invokeai_metadata: '{not valid json' },
        { 'sd-metadata': '{not valid json' },
        { sui_image_params: '{not valid json' },
    ]) {
        assert.doesNotThrow(() => buildSections(metadata));
        const sections = buildSections(metadata);
        assert.ok(Array.isArray(sections));
        assert.ok(sections.some(section => section.id === 'other'));
        assert.doesNotThrow(() => buildGrid(metadata));
    }
});

test('existing generator detection rules remain unchanged', () => {
    assert.equal(detectGenerator({ Description: 'plain description' }), 'Stable Diffusion WebUI');
    assert.equal(detectGenerator({ Description: 'NovelAI image' }), 'NovelAI');
    assert.equal(detectGenerator({ parameters: 'positive\nSteps: 20, Sampler: Euler a' }), 'Stable Diffusion WebUI');
    assert.equal(detectGenerator({ workflow: '{}' }), 'ComfyUI');
});
