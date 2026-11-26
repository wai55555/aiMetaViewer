const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    loadScannerContext,
    exactArrayBuffer,
    makePng,
    pngChunk,
    textChunk,
    itxtChunk,
    tiffWithTags,
} = require('./phase3_helpers.cjs');

const repoRoot = path.resolve(__dirname, '../..');

function pngChunkArray(context) {
    const width = 128;
    const height = 128;
    const zlib = require('node:zlib');
    const raw = Buffer.alloc(height * (width * 4 + 1));
    return {
        width,
        height,
        idat: zlib.deflateSync(raw),
    };
}

test('extractMetadata PNG path is the scanner-only implementation', () => {
    const parserSource = fs.readFileSync(path.join(repoRoot, 'extension/parser.js'), 'utf8');
    assert.equal(/\bfunction\s+extractPngMetadata\s*\(/.test(parserSource), false);
    assert.equal(/\bfunction\s+parsePngTextChunk\s*\(/.test(parserSource), false);
    assert.match(parserSource, /extractPngMetadataWithScanner/);
    assert.match(parserSource, /scanPngMetadataBuffer/);
});

test('B-05 representative PNG cases keep the scanner baseline through extractMetadata', () => {
    const context = loadScannerContext();
    const dimensions = pngChunkArray(context);
    const cases = [
        {
            name: 'tEXt before IDAT',
            png: makePng(context, { ...dimensions, beforeIdat: [textChunk(context, 'parameters', 'before')] }),
            state: 'resolved',
            metadata: { parameters: 'before' },
        },
        {
            name: 'tEXt after IDAT',
            png: makePng(context, { ...dimensions, afterIdat: [textChunk(context, 'Comment', 'after')] }),
            state: 'resolved',
            metadata: { Comment: 'after' },
        },
        {
            name: 'uncompressed iTXt',
            png: makePng(context, { ...dimensions, beforeIdat: [itxtChunk(context, 'parameters', 'itxt-plain')] }),
            state: 'resolved',
            metadata: { parameters: 'itxt-plain' },
        },
        {
            name: 'compressed iTXt',
            png: makePng(context, { ...dimensions, beforeIdat: [itxtChunk(context, 'parameters', 'itxt-compressed', { compressed: true })] }),
            state: 'resolved',
            metadata: { parameters: 'itxt-compressed' },
        },
        {
            name: 'eXIf',
            png: makePng(context, { ...dimensions, afterIdat: [pngChunk(context, 'eXIf', tiffWithTags({ description: 'unified exif' }))] }),
            state: 'resolved',
            metadata: { Description: 'unified exif' },
        },
        {
            name: 'no text',
            png: makePng(context, dimensions),
            state: 'empty-confirmed',
            metadata: {},
        },
        {
            name: 'truncated before IEND',
            png: makePng(context, { ...dimensions, omitIend: true }),
            state: 'unresolved',
            metadata: {},
        },
        {
            name: 'text after IEND (trailing)',
            png: makePng(context, { ...dimensions, trailing: textChunk(context, 'parameters', 'trailing') }),
            state: 'resolved',
            metadata: { parameters: 'trailing' },
        },
    ];

    for (const testCase of cases) {
        const result = context.extractMetadata(exactArrayBuffer(testCase.png), { format: 'png' });
        assert.equal(result.parserState, testCase.state, testCase.name);
        assert.deepEqual({ ...result }, testCase.metadata, testCase.name);
    }
});

test('CRC incremental API remains available to the scanner dependency check', () => {
    const context = loadScannerContext();
    assert.equal(typeof context.createCrc32State, 'function');
    assert.equal(typeof context.updateCrc32, 'function');
    assert.equal(typeof context.finalizeCrc32, 'function');
    assert.equal(typeof context.extractExifPayload, 'function');
    assert.equal(typeof context.scanPngMetadataBuffer, 'function');
});

test('PNG editor writes UTF-8 parameters as iTXt and round-trips through the scanner', () => {
    const context = loadScannerContext();
    const dimensions = pngChunkArray(context);
    const png = makePng(context, dimensions);
    const rewritten = context.writePngMetadata(exactArrayBuffer(png), 'café prompt');
    const result = context.extractMetadata(exactArrayBuffer(Buffer.from(rewritten)), { format: 'png' });
    assert.equal(result.parserState, 'resolved');
    assert.equal(result.parameters, 'café prompt');
});
