/*
 * Build + verify the manual E2E image set for the Stealth on-demand button
 * (docs/stealth-on-demand-e2e.md).
 *
 * Every image is generated here, so the set is reproducible on any machine and
 * carries no third-party artwork. Each case declares the behaviour the browser
 * checklist expects; this script re-derives that behaviour with the real
 * scanner/parser and fails when reality and the declared expectation diverge.
 *
 * Usage:
 *   node tests/e2e/stealth-on-demand/build.cjs
 *   node tests/e2e/stealth-on-demand/build.cjs --keep   # do not rewrite files
 *
 * Output (git-ignored): tests/e2e/stealth-on-demand/images/*.png + MANIFEST.json
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const {
    loadScannerContext,
    exactArrayBuffer,
    makePng,
    textChunk,
} = require('../../metadata/phase3_helpers.cjs');
const { summarize } = require('../../../extension/comfyui_parser.js');

const OUT_DIR = path.join(__dirname, 'images');
const CONTEXT = loadScannerContext();

// content script の minPixelCount（既定 250,000 = 500x500）を超える大きさにする。
// 256x256 では通常モードでバッジが出ず、E2E の前提が崩れる。
const SIZE = 640;

/* ------------------------------------------------------------------ pixels */

/** Deterministic gradient so every fixture looks like an image, not a blank. */
function baseRows(colorType, width, height, bitDepth = 8) {
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
    const stride = bitDepth === 16 ? 2 : 1;
    const rowBytes = width * channels * stride;
    const raw = Buffer.alloc(height * (rowBytes + 1));
    for (let y = 0; y < height; y += 1) {
        const rowStart = y * (rowBytes + 1);
        raw[rowStart] = 0; // filter: none
        for (let x = 0; x < width; x += 1) {
            for (let c = 0; c < channels; c += 1) {
                const base = ((x * 255) / (width - 1) + (y * 3 + c * 40)) % 256;
                const offset = rowStart + 1 + (x * channels + c) * stride;
                if (stride === 1) raw[offset] = base;
                else raw.writeUInt16BE((base << 8) | base, offset);
            }
        }
    }
    return raw;
}

/**
 * Write a stealth payload into pixel LSBs (same bit order the scanner reads).
 * Alpha carriers use one channel; RGB carriers use three bits per pixel.
 */
function embedStealth(raw, options) {
    const { width, height, colorType, bitDepth = 8, signature, payload } = options;
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
    const stride = bitDepth === 16 ? 2 : 1;
    const rowBytes = width * channels * stride;
    const sig = Buffer.from(signature, 'ascii');
    const header = Buffer.alloc(sig.length + 4);
    sig.copy(header, 0);
    header.writeUInt32BE(payload.length * 8, sig.length);
    const full = Buffer.concat([header, payload]);
    const rgbMode = signature.startsWith('stealth_rgb');
    for (let bit = 0; bit < full.length * 8; bit += 1) {
        const value = (full[bit >>> 3] >>> (7 - (bit & 7))) & 1;
        const pixelIndex = rgbMode ? Math.floor(bit / 3) : bit;
        const channel = rgbMode ? bit % 3 : (colorType === 4 ? 1 : 3);
        const x = Math.floor(pixelIndex / height);
        const y = pixelIndex % height;
        if (x >= width) break;
        const offset = y * (rowBytes + 1) + 1 + (x * channels + channel) * stride;
        if (offset >= raw.length) break;
        raw[offset] = (raw[offset] & 0xfe) | value;
    }
    return raw;
}

/* ------------------------------------------------------------------- cases */

const A1111_PARAMETERS = [
    'e2e gradient, soft light',
    'Negative prompt: blurry, lowres',
    'Steps: 28, Sampler: Euler a, CFG scale: 6.5, Seed: 12345, Size: 256x256, Model: e2eModel',
].join('\n');

/** ComfyUI API graph: JPS concat + wildcard + Efficient Loader slots + LoRA Stacker. */
const COMFY_PROMPT = {
    1: { class_type: 'Text Prompt (JPS)', inputs: { text: 'masterpiece, best quality' } },
    2: { class_type: 'PrimitiveString', inputs: { value: '1girl, solo' } },
    3: { class_type: 'ImpactWildcardProcessor', inputs: { wildcard_text: '__lighting__', populated_text: 'soft lighting', mode: 'populate' } },
    4: { class_type: 'Text Concatenate (JPS)', inputs: { delimiter: 'comma', text1: ['1', 0], text2: ['2', 0], text3: ['3', 0] } },
    5: { class_type: 'CLIPTextEncode', inputs: { text: 'bad quality, worst quality' } },
    6: { class_type: 'Efficient Loader', inputs: { positive: ['4', 0], negative: ['5', 0], ckpt_name: 'e2eModel.safetensors' } },
    7: { class_type: 'LoRA Stacker', inputs: { model: ['6', 0], input_mode: 'simple', lora_count: 2, lora_name_1: 'style.safetensors', lora_wt_1: 0.7, lora_name_2: 'None', lora_wt_2: 1 } },
    8: { class_type: 'KSampler', inputs: { seed: 12345, steps: 28, cfg: 6.5, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['7', 0], positive: ['6', 1], negative: ['6', 2] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'e2e' } },
};

const COMFY_POSITIVE = 'masterpiece, best quality, 1girl, solo, soft lighting';
const COMFY_NEGATIVE = 'bad quality, worst quality';
const COMFY_LORA = 'style.safetensors (0.7)';

const ALPHA_PAYLOAD = '{"prompt":"e2e alpha payload","steps":28}';
const RGB_PAYLOAD = '{"prompt":"e2e rgb payload"}';

const CASES = [
    {
        file: '01-stealth-alpha-with-metadata.png',
        role: 'stealth + 通常メタデータ（Alpha 担体）',
        build() {
            return png({ colorType: 6, text: [textChunk(CONTEXT, 'parameters', A1111_PARAMETERS), textChunk(CONTEXT, 'Software', 'NovelAI')], stealth: { signature: 'stealth_pnginfo', payload: ALPHA_PAYLOAD } });
        },
        expect: {
            normalMetadataKeys: ['parameters', 'Software'],
            stealthInNormalScan: false,
            eligible: true,
            stealthSection: 'shown',
            press: `payload: Stealth PNG Info (Alpha) · ${ALPHA_PAYLOAD}`,
        },
    },
    {
        file: '02-normal-metadata-no-stealth.png',
        role: '通常メタデータのみ（ペイロード無し, RGB8 担体）',
        build() {
            return png({ colorType: 2, text: [textChunk(CONTEXT, 'parameters', A1111_PARAMETERS)] });
        },
        expect: {
            normalMetadataKeys: ['parameters'],
            stealthInNormalScan: false,
            eligible: true,
            stealthSection: 'shown',
            press: 'No stealth payload found in the pixel LSBs.',
        },
    },
    {
        file: '03-no-metadata-alpha.png',
        role: 'メタデータ無し（α, ペイロード無し）',
        build() {
            return png({ colorType: 6 });
        },
        expect: {
            normalMetadataKeys: [],
            stealthInNormalScan: false,
            eligible: true,
            stealthSection: 'shown',
            press: 'No stealth payload found in the pixel LSBs.',
        },
    },
    {
        file: '04-comfyui-api-prompt.png',
        role: 'ComfyUI 発端（API prompt: JPS 連結 + Efficient Loader + LoRA Stacker）',
        build() {
            return png({
                colorType: 2,
                text: [textChunk(CONTEXT, 'prompt', JSON.stringify(COMFY_PROMPT, null, 2))],
            });
        },
        expect: {
            normalMetadataKeys: ['prompt'],
            stealthInNormalScan: false,
            eligible: true,
            stealthSection: 'shown',
            press: 'No stealth payload found in the pixel LSBs.',
            comfy: { positive: [COMFY_POSITIVE], negative: [COMFY_NEGATIVE], loras: [COMFY_LORA] },
        },
    },
    {
        file: '05-stealth-only-alpha.png',
        role: 'Stealth のみ（通常メタデータ無し → 通常スキャンで検出済み）',
        build() {
            return png({ colorType: 6, stealth: { signature: 'stealth_pnginfo', payload: ALPHA_PAYLOAD } });
        },
        expect: {
            normalMetadataKeys: ['Stealth PNG Info (Alpha)'],
            stealthInNormalScan: true,
            eligible: true,
            stealthSection: 'hidden: already detected',
            press: 'n/a',
        },
    },
    {
        file: '06-gray8-not-eligible.png',
        role: '非対象レイアウト（Grayscale 8bit）',
        build() {
            return png({ colorType: 0 });
        },
        expect: {
            normalMetadataKeys: [],
            stealthInNormalScan: false,
            eligible: false,
            stealthSection: 'hidden: not eligible',
            press: 'n/a',
        },
    },
    {
        file: '07-rgb16-not-eligible.png',
        role: '非対象レイアウト（RGB 16bit, RGB モードの対象外）',
        build() {
            return png({ colorType: 2, bitDepth: 16 });
        },
        expect: {
            normalMetadataKeys: [],
            stealthInNormalScan: false,
            eligible: false,
            stealthSection: 'hidden: not eligible',
            press: 'n/a',
        },
    },
    {
        file: '08-stealth-rgb-with-metadata.png',
        role: 'stealth + 通常メタデータ（RGB 担体）',
        build() {
            return png({
                colorType: 2,
                text: [textChunk(CONTEXT, 'parameters', A1111_PARAMETERS)],
                stealth: { signature: 'stealth_rgbinfo', payload: RGB_PAYLOAD },
            });
        },
        expect: {
            normalMetadataKeys: ['parameters'],
            stealthInNormalScan: false,
            eligible: true,
            stealthSection: 'shown',
            press: `payload: Stealth PNG Info (RGB) · ${RGB_PAYLOAD}`,
        },
    },
];

function png({ colorType = 6, bitDepth = 8, text = [], stealth = null }) {
    const width = SIZE;
    const height = SIZE;
    let raw = baseRows(colorType, width, height, bitDepth);
    if (stealth) {
        raw = embedStealth(raw, {
            width,
            height,
            colorType,
            bitDepth,
            signature: stealth.signature,
            payload: Buffer.from(stealth.payload, 'utf8'),
        });
    }
    return makePng(CONTEXT, {
        width,
        height,
        colorType,
        bitDepth,
        idat: zlib.deflateSync(raw, { level: 9 }),
        beforeIdat: text,
    });
}

/* ----------------------------------------------------------------- verify */

function ihdrOf(buffer) {
    return CONTEXT.parsePngIhdrInfo(new Uint8Array(buffer.slice(0, Math.min(buffer.length, 64))));
}

function stealthKeyIn(metadata) {
    return Object.keys(metadata || {}).find(key => key.startsWith('Stealth PNG Info')) || null;
}

function verify(testCase, buffer) {
    const ihdr = ihdrOf(buffer);
    const normal = CONTEXT.scanPngMetadataBuffer(exactArrayBuffer(buffer), {});
    const forced = CONTEXT.scanPngMetadataBuffer(exactArrayBuffer(buffer), { forceStealth: true });
    const normalKeys = Object.keys(normal.metadata || {});
    const detected = stealthKeyIn(normal.metadata);
    const expect = testCase.expect;
    const problems = [];

    if (Boolean(ihdr?.stealthEligible) !== expect.eligible) {
        problems.push(`stealthEligible ${ihdr?.stealthEligible} != ${expect.eligible}`);
    }
    const sortedKeys = normalKeys.slice().sort();
    const expectedKeys = expect.normalMetadataKeys.slice().sort();
    if (JSON.stringify(sortedKeys) !== JSON.stringify(expectedKeys)) {
        problems.push(`normal keys ${JSON.stringify(sortedKeys)} != ${JSON.stringify(expectedKeys)}`);
    }
    if (Boolean(detected) !== expect.stealthInNormalScan) {
        problems.push(`stealth in normal scan ${Boolean(detected)} != ${expect.stealthInNormalScan}`);
    }

    const forcedStealth = forced.stealth || null;
    const wantsPayload = expect.press.startsWith('payload:');
    if (wantsPayload && !forcedStealth) problems.push('forced scan found no payload');
    if (!wantsPayload && expect.press !== 'n/a' && forcedStealth) problems.push('forced scan unexpectedly found a payload');

    const uiState = !ihdr?.stealthEligible
        ? 'hidden: not eligible'
        : (detected ? 'hidden: already detected' : 'shown');
    if (uiState !== expect.stealthSection) problems.push(`stealth section ${uiState} != ${expect.stealthSection}`);

    if (wantsPayload && forcedStealth) {
        const rendered = `payload: ${forcedStealth.key}${forcedStealth.compressed ? ' · compressed' : ''} · ${forcedStealth.value}`;
        const wantsCompressed = /compressed/.test(expect.press);
        if (Boolean(forcedStealth.compressed) !== wantsCompressed) {
            problems.push(`compressed flag ${forcedStealth.compressed} != ${wantsCompressed}`);
        }
        if (rendered !== expect.press) problems.push(`rendered result ${JSON.stringify(rendered)} != ${JSON.stringify(expect.press)}`);
    }

    let comfy = null;
    if (expect.comfy) {
        const summary = summarize(normal.metadata || {});
        comfy = {
            positive: summary.positive.map(entry => entry.text),
            negative: summary.negative.map(entry => entry.text),
            loras: summary.loras.map(entry => entry.text),
            unconnected: summary.unconnected.map(entry => entry.text),
        };
        for (const field of ['positive', 'negative', 'loras']) {
            if (JSON.stringify(comfy[field]) !== JSON.stringify(expect.comfy[field])) {
                problems.push(`comfy ${field} ${JSON.stringify(comfy[field])} != ${JSON.stringify(expect.comfy[field])}`);
            }
        }
        const normalized = require('../../../extension/comfyui_parser.js').normalizeGraph(normal.metadata.prompt);
        if (!normalized) problems.push('ComfyUI normalizeGraph rejected the prompt chunk');
    }

    return {
        file: testCase.file,
        role: testCase.role,
        bytes: buffer.length,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        ihdr: {
            width: ihdr?.width,
            height: ihdr?.height,
            bitDepth: ihdr?.bitDepth,
            colorType: ihdr?.colorType,
            stealthEligible: ihdr?.stealthEligible,
        },
        normalMetadataKeys: normalKeys,
        stealthInNormalScan: detected,
        forcedStealth: forcedStealth
            ? {
                key: forcedStealth.key,
                mode: forcedStealth.mode,
                compressed: forcedStealth.compressed,
                value: forcedStealth.value,
            }
            : null,
        ui: { stealthSection: uiState, press: expect.press },
        expect: expect,
        comfy,
        problems,
    };
}

/* ------------------------------------------------------------------- main */

function main() {
    const keep = process.argv.includes('--keep');
    if (!keep) fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const entries = [];
    let failed = false;
    for (const testCase of CASES) {
        const buffer = testCase.build();
        const target = path.join(OUT_DIR, testCase.file);
        if (!keep || !fs.existsSync(target)) fs.writeFileSync(target, buffer);
        const verified = verify(testCase, fs.readFileSync(target));
        entries.push(verified);
        if (verified.problems.length > 0) failed = true;
    }

    const manifest = {
        purpose: 'Manual E2E image set for the on-demand Stealth LSB check (docs/stealth-on-demand-e2e.md §2).',
        generatedBy: 'node tests/e2e/stealth-on-demand/build.cjs',
        size: `${SIZE}x${SIZE}`,
        images: entries,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const rows = entries.map(entry => [
        entry.file,
        `ct=${entry.ihdr.colorType}/${entry.ihdr.bitDepth}b`,
        entry.normalMetadataKeys.join(',') || '(none)',
        entry.ui.stealthSection,
        entry.problems.length ? `FAIL: ${entry.problems.join('; ')}` : 'ok',
    ]);
    const headers = ['file', 'layout', 'normal metadata', 'stealth section', 'verify'];
    const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => row[index].length)));
    const line = row => row.map((cell, index) => cell.padEnd(widths[index])).join('  ');
    console.log(line(headers));
    console.log(line(widths.map(width => '-'.repeat(width))));
    for (const row of rows) console.log(line(row));
    console.log(`\n${entries.length} images -> ${path.relative(process.cwd(), OUT_DIR)} + MANIFEST.json`);
    if (failed) {
        console.error('\nBuild failed: at least one image does not behave as declared.');
        process.exitCode = 1;
    }
}

main();
