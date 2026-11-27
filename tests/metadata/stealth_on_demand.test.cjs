/*
 * On-demand Stealth scan (metadata modal button) and PNG colour probe.
 *
 * The normal scan suppresses Stealth as soon as tEXt/iTXt/zTXt/eXIf metadata is
 * confirmed, so the modal offers an explicit "check" that re-scans with
 * `forceStealth`. These tests pin both behaviours: no suppression change in the
 * default path, and a separate `stealth` field (never merged into `metadata`)
 * when forced.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
    loadScannerContext,
    loadParserContext,
    exactArrayBuffer,
    makePng,
    pngChunk,
    textChunk,
} = require('./phase3_helpers.cjs');

function makeIhdr(width, height, colorType = 6, bitDepth = 8, interlace = 0) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = bitDepth;
    ihdr[9] = colorType;
    ihdr[12] = interlace;
    return ihdr;
}

function channelsFor(colorType) {
    return { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
}

/**
 * Build a PNG whose pixel LSBs carry a stealth payload.
 * @param {Object} context - scanner context
 * @param {Object} options
 * @returns {Buffer}
 */
function stealthPng(context, {
    text = '{"prompt":"on demand"}',
    payload: payloadBytes = null,
    signature = 'stealth_pnginfo',
    colorType = 6,
    beforeIdat = [],
    width = 64,
    height = 64,
} = {}) {
    const channels = channelsFor(colorType);
    const rowBytes = width * channels;
    const raw = Buffer.alloc(height * (rowBytes + 1));
    const sig = Buffer.from(signature, 'ascii');
    const payload = payloadBytes instanceof Buffer ? payloadBytes : Buffer.from(text, 'utf8');
    const header = Buffer.alloc(sig.length + 4);
    sig.copy(header, 0);
    header.writeUInt32BE(payload.length * 8, sig.length);
    const full = Buffer.concat([header, payload]);

    for (let bit = 0; bit < full.length * 8; bit += 1) {
        const value = (full[bit >>> 3] >>> (7 - (bit & 7))) & 1;
        const pixelIndex = signature.startsWith('stealth_rgb') ? Math.floor(bit / 3) : bit;
        const channel = signature.startsWith('stealth_rgb') ? bit % 3 : (colorType === 4 ? 1 : 3);
        const x = Math.floor(pixelIndex / height);
        const y = pixelIndex % height;
        if (x >= width) break;
        const offset = y * (rowBytes + 1) + 1 + x * channels + channel;
        if (offset >= raw.length) break;
        raw[offset] = (raw[offset] & 0xfe) | value;
    }
    return makePng(context, {
        width,
        height,
        colorType,
        idat: zlib.deflateSync(raw),
        beforeIdat,
    });
}

test('the default scan still suppresses Stealth when normal metadata exists', () => {
    const context = loadScannerContext();
    const png = stealthPng(context, {
        beforeIdat: [textChunk(context, 'parameters', 'steps: 20')],
    });
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    assert.equal(result.status, 'normal');
    assert.equal(result.metadata.parameters, 'steps: 20');
    assert.equal(result.stealth, undefined);
    assert.equal(result.metadata['Stealth PNG Info (Alpha)'], undefined);
});

test('forceStealth reports the payload separately without touching metadata', () => {
    const context = loadScannerContext();
    const png = stealthPng(context, {
        text: '{"prompt":"hidden alpha payload"}',
        beforeIdat: [textChunk(context, 'parameters', 'steps: 20')],
    });
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png), { forceStealth: true });
    assert.equal(result.status, 'normal');
    assert.equal(result.metadata.parameters, 'steps: 20');
    assert.equal(result.metadata['Stealth PNG Info (Alpha)'], undefined);
    assert.equal(result.stealth.key, 'Stealth PNG Info (Alpha)');
    assert.equal(result.stealth.value, '{"prompt":"hidden alpha payload"}');
    assert.equal(result.stealth.mode, 'Alpha');
    assert.equal(result.stealth.signature, 'stealth_pnginfo');
    assert.equal(result.stealth.compressed, false);
});

test('forceStealth reports nothing when the payload is absent', () => {
    const context = loadScannerContext();
    const png = makePng(context, {
        width: 8,
        height: 8,
        idat: zlib.deflateSync(Buffer.alloc(8 * (8 * 4 + 1))),
        beforeIdat: [textChunk(context, 'parameters', 'steps: 20')],
    });
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png), { forceStealth: true });
    assert.equal(result.status, 'normal');
    assert.equal(result.stealth, undefined);
});

test('forceStealth flags compressed and RGB payloads', () => {
    const context = loadScannerContext();

    const compressedPayload = zlib.deflateSync(Buffer.from('compressed payload', 'utf8'));
    const compressed = stealthPng(context, {
        payload: compressedPayload,
        signature: 'stealth_pngcomp',
        beforeIdat: [textChunk(context, 'parameters', 'steps: 20')],
    });
    const compressedResult = context.scanPngMetadataBuffer(exactArrayBuffer(compressed), { forceStealth: true });
    assert.ok(compressedResult.stealth, 'compressed payload should be reported');
    assert.equal(compressedResult.stealth.compressed, true);

    const rgb = stealthPng(context, {
        text: '{"prompt":"rgb payload"}',
        signature: 'stealth_rgbinfo',
        colorType: 2,
        beforeIdat: [textChunk(context, 'parameters', 'steps: 20')],
    });
    const rgbResult = context.scanPngMetadataBuffer(exactArrayBuffer(rgb), { forceStealth: true });
    assert.ok(rgbResult.stealth, 'RGB payload should be reported');
    assert.equal(rgbResult.stealth.mode, 'RGB');
    assert.equal(rgbResult.stealth.value, '{"prompt":"rgb payload"}');
});

test('parsePngIhdrInfo gates the on-demand button', () => {
    const context = loadParserContext();
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'IHDR', makeIhdr(1024, 768, 6, 8)),
    ]);

    const rgba = context.parsePngIhdrInfo(png);
    assert.equal(rgba.format, 'png');
    assert.equal(rgba.width, 1024);
    assert.equal(rgba.height, 768);
    assert.equal(rgba.bitDepth, 8);
    assert.equal(rgba.colorType, 6);
    assert.equal(rgba.hasAlpha, true);
    assert.equal(rgba.stealthEligible, true);

    const grayAlpha = context.parsePngIhdrInfo(Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'IHDR', makeIhdr(32, 32, 4, 8)),
    ]));
    assert.equal(grayAlpha.hasAlpha, true);
    assert.equal(grayAlpha.stealthEligible, true);

    const rgb8 = context.parsePngIhdrInfo(Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'IHDR', makeIhdr(32, 32, 2, 8)),
    ]));
    assert.equal(rgb8.hasAlpha, false);
    assert.equal(rgb8.hasRgb, true);
    assert.equal(rgb8.stealthEligible, true);

    const rgb16 = context.parsePngIhdrInfo(Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'IHDR', makeIhdr(32, 32, 2, 16)),
    ]));
    assert.equal(rgb16.stealthEligible, false, '16-bit RGB has no scanner layout for RGB mode');

    const gray = context.parsePngIhdrInfo(Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'IHDR', makeIhdr(32, 32, 0, 8)),
    ]));
    assert.equal(gray.stealthEligible, false);

    const jpeg = context.parsePngIhdrInfo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
    assert.equal(jpeg, null);

    const short = context.parsePngIhdrInfo(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
    assert.equal(short, null);
});
