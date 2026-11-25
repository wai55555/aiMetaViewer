const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeGraph, summarize } = require('../../extension/comfyui_parser.js');

function apiGraph() {
    return {
        '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'elf-v4.safetensors' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a silver-haired elf' } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, extra fingers' } },
        '4': { class_type: 'LoraLoader', inputs: { lora_name: 'soft-light.safetensors', strength_model: 0.65, model: ['1', 0], clip: ['1', 1] } },
        '5': { class_type: 'KSampler', inputs: { seed: 41, steps: 28, cfg: 6.5, sampler_name: 'dpmpp_2m', scheduler: 'karras', model: ['4', 0], positive: ['2', 0], negative: ['3', 0] } },
        '6': { class_type: 'SaveImage', inputs: { images: ['5', 0], filename_prefix: 'output' } },
    };
}

function uiWorkflow() {
    return {
        nodes: [
            { id: 1, type: 'CheckpointLoaderSimple', widgets_values: ['checkpoint.safetensors'], inputs: [] },
            { id: 2, type: 'CLIPTextEncode', widgets_values: ['UI positive prompt'], inputs: [] },
            { id: 3, type: 'CLIPTextEncode', title: 'Negative Prompt', widgets_values: ['UI negative prompt'], inputs: [] },
            { id: 4, type: 'LoraLoader', widgets_values: ['glow.safetensors', 0.8, 0.75], inputs: [{ name: 'model', link: 24 }, { name: 'clip', link: 25 }] },
            { id: 5, type: 'KSampler', widgets_values: [123, 'fixed', 20, 7, 'euler', 'normal', 1], inputs: [{ name: 'model', link: 26 }, { name: 'positive', link: 27 }, { name: 'negative', link: 28 }] },
            { id: 6, type: 'SaveImage', inputs: [{ name: 'images', link: 29 }] },
        ],
        links: [
            [24, 1, 0, 4, 0, 'MODEL'],
            [25, 1, 1, 4, 1, 'CLIP'],
            [26, 4, 0, 5, 0, 'MODEL'],
            [27, 2, 0, 5, 1, 'CONDITIONING'],
            [28, 3, 0, 5, 2, 'CONDITIONING'],
            [29, 5, 0, 6, 0, 'IMAGE'],
        ],
    };
}

test('API prompt links become positive/negative summaries, model, LoRA and sampler rows', () => {
    const result = summarize({ prompt: apiGraph() });
    assert.deepEqual(result.positive.map(entry => entry.text), ['a silver-haired elf']);
    assert.deepEqual(result.negative.map(entry => entry.text), ['blurry, extra fingers']);
    assert.deepEqual(result.models.map(entry => entry.text), ['elf-v4.safetensors']);
    assert.deepEqual(result.loras.map(entry => entry.text), ['soft-light.safetensors (0.65)']);
    assert.deepEqual(Object.fromEntries(result.grid.map(row => [row.key, row.value])), {
        Seed: '41',
        Steps: '28',
        CFG: '6.5',
        Sampler: 'dpmpp_2m',
        Scheduler: 'karras',
        LoRA: 'soft-light.safetensors (0.65)',
        Model: 'elf-v4.safetensors',
    });
});

test('UI workflow links and widgets_values are normalized into the same summary', () => {
    const result = summarize({ workflow: uiWorkflow() });
    assert.deepEqual(result.positive.map(entry => entry.text), ['UI positive prompt']);
    assert.deepEqual(result.negative.map(entry => entry.text), ['UI negative prompt']);
    assert.deepEqual(result.models.map(entry => entry.text), ['checkpoint.safetensors']);
    assert.deepEqual(result.loras.map(entry => entry.text), ['glow.safetensors (0.8)']);
    assert.ok(result.grid.some(row => row.key === 'Seed' && row.value === '123'));
    assert.ok(result.grid.some(row => row.key === 'Sampler' && row.value === 'euler'));
});

test('ComfyUI summary parses a raw workflow JSON string without requiring object conversion', () => {
    const rawWorkflow = JSON.stringify(uiWorkflow());
    const result = summarize({ workflow: rawWorkflow });
    assert.equal(result.positive[0].text, 'UI positive prompt');
    assert.equal(result.negative[0].text, 'UI negative prompt');
});

test('SDXL widget prompt fields follow the exported dimension-first order', () => {
    const result = summarize({ workflow: {
        nodes: [
            { id: 1, type: 'CLIPTextEncodeSDXL', widgets_values: [1024, 1024, 0, 0, 1024, 1024, 'wide scene', 'fine texture'], inputs: [] },
            { id: 2, type: 'KSampler', widgets_values: [1, 'fixed', 20, 5, 'euler', 'normal', 1], inputs: [{ name: 'positive', link: 4 }] },
            { id: 3, type: 'SaveImage', inputs: [{ name: 'images', link: 5 }] },
        ],
        links: [
            [4, 1, 0, 2, 0, 'CONDITIONING'],
            [5, 2, 0, 3, 0, 'IMAGE'],
        ],
    } });
    assert.equal(result.positive[0].text, 'wide scene\nfine texture');
});

test('UI widgets map UNET loader names and KSamplerAdvanced settings without shifting values', () => {
    const result = summarize({ workflow: {
        nodes: [
            { id: 1, type: 'UNETLoader', widgets_values: ['wan-model.safetensors', 'default'], inputs: [], outputs: [{ name: 'MODEL', slot_index: 0 }] },
            { id: 2, type: 'CLIPTextEncode', widgets_values: ['video prompt'], inputs: [], outputs: [{ name: 'CONDITIONING', slot_index: 0 }] },
            { id: 3, type: 'KSamplerAdvanced', widgets_values: [true, 123, 'fixed', 30, 6, 'euler', 'normal', 0, 30, false], inputs: [{ name: 'model', link: 1 }, { name: 'positive', link: 2 }] },
            { id: 4, type: 'SaveVideo', inputs: [{ name: 'video', link: 3 }] },
        ],
        links: [
            [1, 1, 0, 3, 0, 'MODEL'],
            [2, 2, 0, 3, 1, 'CONDITIONING'],
            [3, 3, 0, 4, 0, 'VIDEO'],
        ],
    } });
    assert.deepEqual(result.models.map(entry => entry.text), ['wan-model.safetensors']);
    assert.ok(result.grid.some(row => row.key === 'Steps' && row.value === '30'));
    assert.ok(result.grid.some(row => row.key === 'CFG' && row.value === '6'));
    assert.ok(result.grid.some(row => row.key === 'Sampler' && row.value === 'euler'));
});

test('conditioning output slots keep positive and negative source prompts separate', () => {
    const result = summarize({ workflow: {
        nodes: [
            { id: 1, type: 'CLIPTextEncode', title: 'Positive', widgets_values: ['bright'], inputs: [], outputs: [{ name: 'CONDITIONING', slot_index: 0 }] },
            { id: 2, type: 'CLIPTextEncode', title: 'Negative', widgets_values: ['blurry'], inputs: [], outputs: [{ name: 'CONDITIONING', slot_index: 0 }] },
            { id: 3, type: 'ControlNetApplyAdvanced', inputs: [{ name: 'positive', link: 1 }, { name: 'negative', link: 2 }], outputs: [{ name: 'CONDITIONING', slot_index: 0 }, { name: 'CONDITIONING', slot_index: 1 }] },
            { id: 4, type: 'KSampler', widgets_values: [1, 'fixed', 20, 5, 'euler', 'normal', 1], inputs: [{ name: 'positive', link: 3 }, { name: 'negative', link: 4 }] },
            { id: 5, type: 'SaveImage', inputs: [{ name: 'images', link: 5 }] },
        ],
        links: [
            [1, 1, 0, 3, 0, 'CONDITIONING'],
            [2, 2, 0, 3, 1, 'CONDITIONING'],
            [3, 3, 0, 4, 0, 'CONDITIONING'],
            [4, 3, 1, 4, 1, 'CONDITIONING'],
            [5, 4, 0, 5, 0, 'IMAGE'],
        ],
    } });
    assert.deepEqual(result.positive.map(entry => entry.text), ['bright']);
    assert.deepEqual(result.negative.map(entry => entry.text), ['blurry']);
});

test('conditioning inputs combined from separate output slots are both retained', () => {
    const result = summarize({ workflow: {
        nodes: [
            { id: 1, type: 'CLIPTextEncode', widgets_values: ['bright'], inputs: [] },
            { id: 2, type: 'CLIPTextEncode', widgets_values: ['blurry'], inputs: [] },
            { id: 3, type: 'ControlNetApplyAdvanced', inputs: [{ name: 'positive', link: 1 }, { name: 'negative', link: 2 }], outputs: [{ name: 'CONDITIONING' }, { name: 'CONDITIONING' }] },
            { id: 4, type: 'ConditioningCombine', inputs: [{ name: 'conditioning_1', link: 3 }, { name: 'conditioning_2', link: 4 }] },
            { id: 5, type: 'KSampler', widgets_values: [1, 'fixed', 20, 5, 'euler', 'normal', 1], inputs: [{ name: 'positive', link: 5 }] },
            { id: 6, type: 'SaveImage', inputs: [{ name: 'images', link: 6 }] },
        ],
        links: [
            [1, 1, 0, 3, 0, 'CONDITIONING'],
            [2, 2, 0, 3, 1, 'CONDITIONING'],
            [3, 3, 0, 4, 0, 'CONDITIONING'],
            [4, 3, 1, 4, 1, 'CONDITIONING'],
            [5, 4, 0, 5, 0, 'CONDITIONING'],
            [6, 5, 0, 6, 0, 'IMAGE'],
        ],
    } });
    assert.deepEqual(new Set(result.positive.map(entry => entry.text)), new Set(['bright', 'blurry']));
});

test('outputs keep branches separate and disconnected LoRAs are ignored', () => {
    const graph = apiGraph();
    graph['7'] = { class_type: 'SaveImage', inputs: { images: ['5', 0] }, title: 'Second output' };
    graph['8'] = { class_type: 'LoraLoader', inputs: { lora_name: 'unconnected.safetensors', strength_model: 1 } };
    graph['9'] = { class_type: 'CLIPTextEncode', inputs: { text: 'orphan prompt' } };
    const result = summarize({ prompt: graph });
    assert.equal(result.positive.length, 2);
    assert.deepEqual(new Set(result.positive.map(entry => entry.label)), new Set(['SaveImage', 'Second output']));
    assert.equal(result.loras.some(entry => entry.text.includes('unconnected')), false);
    assert.deepEqual(result.unconnected.map(entry => [entry.label, entry.text]), [['CLIPTextEncode', 'orphan prompt']]);
});

test('video input nodes are not mistaken for workflow outputs', () => {
    const result = summarize({ prompt: {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'prompt for generated video' } },
        '2': { class_type: 'KSampler', inputs: { positive: ['1', 0], steps: 16 } },
        '3': { class_type: 'VHS_LoadVideo', inputs: { video: 'source.mp4' } },
    } });
    assert.ok(result.positive.some(entry => entry.text === 'prompt for generated video'));
    assert.ok(result.grid.some(row => row.key === 'Steps' && row.value === '16'));
});

test('graph traversal handles cycles and malformed JSON without throwing', () => {
    const cyclic = {
        '1': { class_type: 'KSampler', inputs: { model: ['2', 0], positive: ['3', 0], negative: ['3', 0], steps: 1 } },
        '2': { class_type: 'LoraLoader', inputs: { model: ['1', 0], lora_name: 'cycle.safetensors' } },
        '3': { class_type: 'CLIPTextEncode', inputs: { text: 'cycle-safe prompt' } },
        '4': { class_type: 'SaveImage', inputs: { images: ['1', 0] } },
    };
    const result = summarize({ prompt: cyclic });
    assert.ok(result.positive.some(entry => entry.text === 'cycle-safe prompt'));
    assert.equal(normalizeGraph('{"nodes":'), null);
    assert.doesNotThrow(() => summarize({ prompt: '{"nodes":' }));
    assert.equal(summarize({ prompt: '{"nodes":' }).positive.length, 0);
});

test('output graph limit bounds unusually large workflow payloads', () => {
    const graph = {};
    for (let index = 0; index < 12000; index++) {
        graph[String(index)] = { class_type: 'NoOp', inputs: {} };
    }
    const normalized = normalizeGraph(graph);
    assert.ok(normalized.nodes.size <= 10000);
    assert.equal(normalized.limited, true);
    assert.equal(summarize({ prompt: graph }).limited, true);
});

test('summary traversal work is capped for large connected workflow graphs', () => {
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

    const result = summarize({ prompt: graph });
    assert.equal(result.limited, true);
    assert.ok(result.positive.length <= 200);
    assert.ok(result.negative.length <= 200);
});

test('normalization caps dense connection graphs and marks the summary limited', () => {
    const inputs = {};
    for (let index = 0; index < 20001; index++) inputs[`link_${index}`] = ['source', 0];
    const normalized = normalizeGraph({
        source: { class_type: 'NoOp', inputs: {} },
        output: { class_type: 'SaveImage', inputs },
    });
    assert.equal(normalized.inbound.get('output').length, 20000);
    assert.equal(normalized.limited, true);
});

test('API object keys remain authoritative when payload nodes contain an id property', () => {
    const graph = normalizeGraph({
        'node-key': { id: 'spoofed-id', class_type: 'CLIPTextEncode', inputs: { text: 'preserved' } },
    });
    assert.equal(graph.nodes.has('node-key'), true);
    assert.equal(graph.nodes.has('spoofed-id'), false);
});
