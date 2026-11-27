/*
 * ComfyUI prompt-detection cost measurement.
 *
 * Measures the two carriers the fallback work touches (metadata-free images and
 * plain CLIPTextEncode graphs) plus the reduced JPS/Efficient-Loader fixture,
 * so a change in resolve cost is visible before/after.
 *
 * Run with:
 *   node tests/perf/comfyui_prompt_cost.cjs
 *   node tests/perf/comfyui_prompt_cost.cjs --json
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '../..');
const EXT = path.join(ROOT, 'extension');
const fixtures = require('../metadata/fixtures/comfyui_prompt_fixtures.cjs');

const ComfyUIParser = require(path.join(EXT, 'comfyui_parser.js'));
const uiSource = fs.readFileSync(path.join(EXT, 'ui.js'), 'utf8');
const uiContext = { window: { ComfyUIParser }, console };
vm.runInNewContext(uiSource, uiContext);

const detectGenerator = uiContext.window.detectGenerator;
const buildSections = uiContext.window.buildSections;

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
}

function measure(fn, { iterations, warmup }) {
    for (let i = 0; i < warmup; i += 1) fn();
    const samples = new Float64Array(iterations);
    for (let i = 0; i < iterations; i += 1) {
        const start = performance.now();
        fn();
        samples[i] = performance.now() - start;
    }
    const sorted = Array.from(samples).sort((a, b) => a - b);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    return {
        iterations,
        meanMs: total / sorted.length,
        medianMs: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        maxMs: sorted[sorted.length - 1],
    };
}

const cases = [
    {
        id: 'empty',
        label: 'メタデータ無し',
        metadata: fixtures.emptyMetadata(),
        iterations: 20000,
        warmup: 2000,
    },
    {
        id: 'plain-clip',
        label: '素のCLIPTextEncodeのみ (7ノード)',
        metadata: fixtures.plainClipTextEncodeMetadata(),
        iterations: 5000,
        warmup: 500,
    },
    {
        id: 'jps-efficient-loader',
        label: 'JPS連結 + Efficient Loader (縮約フィクスチャ)',
        metadata: fixtures.jpsEfficientLoaderMetadata(),
        iterations: 1000,
        warmup: 100,
    },
];

const results = [];
for (const testCase of cases) {
    const metadata = testCase.metadata;
    const options = { iterations: testCase.iterations, warmup: testCase.warmup };
    const summary = ComfyUIParser.summarize(metadata);
    results.push({
        id: testCase.id,
        label: testCase.label,
        graphNodes: metadata.prompt ? Object.keys(metadata.prompt).length : 0,
        positive: summary.positive.length,
        negative: summary.negative.length,
        unconnected: summary.unconnected.length,
        detect: measure(() => detectGenerator(metadata), options),
        summarize: measure(() => ComfyUIParser.summarize(metadata), options),
        buildSections: measure(() => buildSections(metadata), options),
        buildGrid: measure(() => uiContext.window.buildGrid(metadata), options),
    });
}

if (process.argv.includes('--json')) {
    console.log(JSON.stringify({
        node: process.version,
        platform: `${process.platform}/${process.arch}`,
        cpu: (require('node:os').cpus()[0] || {}).model || 'unknown',
        generatedAt: new Date().toISOString(),
        results,
    }, null, 2));
    process.exit(0);
}

console.log(`node ${process.version} / ${process.platform}-${process.arch} / ${(require('node:os').cpus()[0] || {}).model}`);
console.log('');
console.log('| ケース | ノード数 | detectGenerator | summarize | buildSections | buildGrid | pos/neg/unconn |');
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const result of results) {
    const fmt = entry => `${entry.medianMs.toFixed(4)} ms (p95 ${entry.p95Ms.toFixed(4)})`;
    console.log(`| ${result.label} | ${result.graphNodes} | ${fmt(result.detect)} | ${fmt(result.summarize)} | ${fmt(result.buildSections)} | ${fmt(result.buildGrid)} | ${result.positive}/${result.negative}/${result.unconnected} |`);
}
console.log('');
console.log('iterations: ' + results.map(result => `${result.id}=${result.summarize.iterations}`).join(', '));
