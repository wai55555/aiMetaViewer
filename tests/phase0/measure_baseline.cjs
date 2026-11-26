/*
 * Phase 0 baseline measurement helpers.
 *
 * This file is test-only tooling for docs/perf-baseline-1.8.md. It does not
 * modify or import product state other than the existing extension scripts.
 * Run with: node tests/phase0/measure_baseline.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '../..');
const EXT = path.join(ROOT, 'extension');

function createContext() {
    const context = vm.createContext({
        console,
        TextDecoder,
        TextEncoder,
        Uint8Array,
        ArrayBuffer,
        DataView,
    });
    context.window = context;
    for (const file of ['parser.js', 'pako.js', 'png_metadata_scanner.js']) {
        vm.runInContext(fs.readFileSync(path.join(EXT, file), 'utf8'), context, { filename: file });
    }
    return context;
}

function be32(value) {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value >>> 0);
    return result;
}

function pngChunk(context, type, data) {
    const typeBytes = Buffer.from(type, 'ascii');
    const payload = Buffer.from(data);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(context.computeCrc32(Buffer.concat([typeBytes, payload])) >>> 0);
    return Buffer.concat([be32(payload.length), typeBytes, payload, crc]);
}

function makePng(context, { width, height, colorType = 6, bitDepth = 8, idat, beforeIdat = [], afterIdat = [], omitIend = false }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = bitDepth;
    ihdr[9] = colorType;
    const chunks = [
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'IHDR', ihdr),
        ...beforeIdat,
        pngChunk(context, 'IDAT', idat),
        ...afterIdat,
    ];
    if (!omitIend) chunks.push(pngChunk(context, 'IEND', Buffer.alloc(0)));
    return Buffer.concat(chunks);
}

function tiffWithDescription(description) {
    const value = Buffer.from(`${description}\0`, 'utf8');
    const tiff = Buffer.alloc(8 + 2 + 12 + 4 + value.length);
    tiff.write('II', 0, 'ascii');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x010e, 10);
    tiff.writeUInt16LE(2, 12);
    tiff.writeUInt32LE(value.length, 14);
    tiff.writeUInt32LE(26, 18);
    tiff.writeUInt32LE(0, 22);
    value.copy(tiff, 26);
    return tiff;
}

function textChunk(context, keyword, text) {
    return pngChunk(context, 'tEXt', Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from(text, 'utf8'),
    ]));
}

function itxtChunk(context, keyword, text, compressed) {
    const textBytes = Buffer.from(text, 'utf8');
    const body = compressed ? zlib.deflateSync(textBytes) : textBytes;
    return pngChunk(context, 'iTXt', Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from([compressed ? 1 : 0, 0]),
        Buffer.from([0]),
        Buffer.from([0]),
        body,
    ]));
}

function simpleIdat(width, height, colorType = 6, bitDepth = 8) {
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    const rowBytes = width * channels * (bitDepth / 8);
    return zlib.deflateSync(Buffer.alloc(height * (rowBytes + 1)));
}

function stealthIdat(width, height, colorType, signatureName, payloadBytes) {
    const channels = { 2: 3, 4: 2, 6: 4 }[colorType];
    const pixelStride = channels;
    const rowBytes = width * pixelStride;
    const reconstructed = Buffer.alloc(height * rowBytes);
    const signature = Buffer.from(signatureName, 'ascii');
    const bitLength = payloadBytes.length * 8;
    const header = Buffer.alloc(signature.length + 4);
    signature.copy(header, 0);
    header.writeUInt32BE(bitLength, signature.length);
    const full = Buffer.concat([header, payloadBytes]);
    const alphaMode = signatureName.endsWith('pnginfo') || signatureName.endsWith('pngcomp');
    const offsets = alphaMode ? [pixelStride - 1] : [0, 1, 2];
    for (let bitIndex = 0; bitIndex < full.length * 8; bitIndex += 1) {
        const bit = (full[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
        const pixelIndex = alphaMode ? Math.floor(bitIndex / height) : Math.floor(bitIndex / 3 / height);
        const y = alphaMode ? bitIndex % height : Math.floor(bitIndex / 3) % height;
        const channel = alphaMode ? 0 : bitIndex % 3;
        if (pixelIndex >= width || y >= height) throw new Error('stealth fixture payload exceeds image capacity');
        const byteOffset = y * rowBytes + pixelIndex * pixelStride + offsets[channel];
        reconstructed[byteOffset] = (reconstructed[byteOffset] & 0xfe) | bit;
    }
    const filtered = Buffer.alloc(height * (rowBytes + 1));
    for (let y = 0; y < height; y += 1) {
        filtered[y * (rowBytes + 1)] = 0;
        reconstructed.copy(filtered, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
    }
    return zlib.deflateSync(filtered);
}

function exactArrayBuffer(bytes) {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function plainMetadata(metadata) {
    if (!metadata) return {};
    const result = {};
    for (const key of Object.keys(metadata)) result[key] = metadata[key];
    return result;
}

function summarizeOld(metadata) {
    return {
        parserState: metadata.parserState,
        metadata: plainMetadata(metadata),
        metadataPartial: metadata.metadataPartial === true || undefined,
        isIncomplete: metadata.isIncomplete === true || undefined,
        suggestedSize: metadata.suggestedSize,
    };
}

function summarizeScanner(result) {
    return {
        status: result.status,
        reason: result.reason,
        metadata: plainMetadata(result.metadata),
        metadataPartial: result.metadataPartial === true || undefined,
        diagnostics: [...new Set((result.diagnostics || []).map((entry) => entry.category))],
    };
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

function measure(context, png, runs = 6) {
    const durations = [];
    let lastResult = null;
    for (let index = 0; index < runs; index += 1) {
        const input = exactArrayBuffer(png);
        const started = performance.now();
        lastResult = context.scanPngMetadataBuffer(input);
        durations.push(performance.now() - started);
    }
    return {
        runs: durations.map((value) => Number(value.toFixed(3))),
        measured: durations.slice(1).map((value) => Number(value.toFixed(3))),
        medianMs: Number(median(durations.slice(1)).toFixed(3)),
        status: lastResult.status,
        metadataKeys: lastResult.metadata ? Object.keys(lastResult.metadata) : [],
    };
}

function buildB04Fixtures(context) {
    const cases = [];
    const width = 4096;
    const height = 4096;
    cases.push({
        id: 'a',
        label: '4096x4096 / metadata none',
        png: makePng(context, {
            width,
            height,
            idat: simpleIdat(width, height),
        }),
    });
    cases.push({
        id: 'b',
        label: '4096x4096 / tEXt before IDAT',
        png: makePng(context, {
            width,
            height,
            beforeIdat: [textChunk(context, 'parameters', 'phase0-before-idat')],
            idat: simpleIdat(width, height),
        }),
    });
    cases.push({
        id: 'b2',
        label: '4096x4096 / tEXt after IDAT',
        png: makePng(context, {
            width,
            height,
            idat: simpleIdat(width, height),
            afterIdat: [textChunk(context, 'parameters', 'phase0-after-idat')],
        }),
    });
    cases.push({
        id: 'c',
        label: '1024x1024 / Alpha Stealth present',
        png: makePng(context, {
            width: 1024,
            height: 1024,
            idat: stealthIdat(
                1024,
                1024,
                6,
                'stealth_pnginfo',
                Buffer.from('{"prompt":"phase0 stealth baseline"}', 'utf8'),
            ),
        }),
    });
    return cases;
}

function buildB05Cases(context) {
    const width = 32;
    const height = 32;
    const idat = simpleIdat(width, height);
    const cases = [];
    cases.push({
        id: 'text-before-idat',
        png: makePng(context, {
            width, height,
            beforeIdat: [textChunk(context, 'parameters', 'before-idat')],
            idat,
        }),
    });
    cases.push({
        id: 'text-after-idat',
        png: makePng(context, {
            width, height, idat,
            afterIdat: [textChunk(context, 'Comment', 'after-idat')],
        }),
    });
    cases.push({
        id: 'itxt-uncompressed',
        png: makePng(context, {
            width, height,
            beforeIdat: [itxtChunk(context, 'parameters', 'itxt-plain', false)],
            idat,
        }),
    });
    cases.push({
        id: 'itxt-compressed',
        png: makePng(context, {
            width, height,
            beforeIdat: [itxtChunk(context, 'parameters', 'itxt-compressed', true)],
            idat,
        }),
    });
    cases.push({
        id: 'exif',
        png: makePng(context, {
            width, height,
            beforeIdat: [pngChunk(context, 'eXIf', tiffWithDescription('phase0 exif'))],
            idat,
        }),
    });
    cases.push({
        id: 'stealth',
        png: makePng(context, {
            width: 128,
            height: 128,
            idat: stealthIdat(128, 128, 6, 'stealth_pnginfo', Buffer.from('phase0 stealth', 'utf8')),
        }),
    });
    cases.push({
        id: 'no-text',
        png: makePng(context, { width, height, idat }),
    });
    cases.push({
        id: 'truncated-before-iend',
        png: makePng(context, { width, height, idat, omitIend: true }),
    });
    cases.push({
        id: 'text-after-iend',
        png: Buffer.concat([
            makePng(context, { width, height, idat, omitIend: true }),
            pngChunk(context, 'IEND', Buffer.alloc(0)),
            textChunk(context, 'Comment', 'after-iend'),
        ]),
    });
    return cases;
}

function main() {
    const context = createContext();
    const b04 = buildB04Fixtures(context).map((testCase) => ({
        id: testCase.id,
        label: testCase.label,
        bytes: testCase.png.length,
        ...measure(context, testCase.png),
    }));
    const b05 = buildB05Cases(context).map((testCase) => {
        const buffer = exactArrayBuffer(testCase.png);
        const oldResult = context.extractPngMetadata(buffer);
        const scannerResult = context.scanPngMetadataBuffer(buffer);
        return {
            id: testCase.id,
            bytes: testCase.png.length,
            old: summarizeOld(oldResult),
            scanner: summarizeScanner(scannerResult),
        };
    });
    process.stdout.write(`${JSON.stringify({ node: process.version, b04, b05 }, null, 2)}\n`);
}

main();
