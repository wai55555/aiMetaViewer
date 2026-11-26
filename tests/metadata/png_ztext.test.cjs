const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
    loadScannerContext,
    exactArrayBuffer,
    makePng,
    pngChunk,
    textChunk,
    ztxtChunk,
    mockStream,
} = require('./phase3_helpers.cjs');

test('PNG reads all allow-listed zTXt keywords', () => {
    const context = loadScannerContext();
    const allowed = ['parameters', 'prompt', 'workflow', 'generation_data', 'Comment', 'Description', 'Software', 'Source'];
    for (const keyword of allowed) {
        const png = makePng(context, { afterIdat: [ztxtChunk(context, keyword, `${keyword}-value`)] });
        const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
        assert.equal(result.status, 'normal', keyword);
        assert.equal(result.metadata[keyword], `${keyword}-value`);
    }
});

test('PNG does not inflate a non-allow-listed zTXt and does not buffer its full payload', () => {
    const context = loadScannerContext();
    const baselinePng = makePng(context);
    const realInflate = context.pako.Inflate;
    let inflateCalls = 0;
    context.pako.Inflate = function countedInflate(...args) {
        inflateCalls += 1;
        return new realInflate(...args);
    };
    context.scanPngMetadataBuffer(exactArrayBuffer(baselinePng));
    const baselineCalls = inflateCalls;

    const hugeCompressed = Buffer.alloc(3 * 1024 * 1024);
    const huge = makePng(context, {
        afterIdat: [ztxtChunk(context, 'Other', '', { compressed: hugeCompressed })],
    });

    const allocations = [];
    const NativeUint8Array = context.Uint8Array;
    class TrackingUint8Array extends NativeUint8Array {
        constructor(...args) {
            if (typeof args[0] === 'number') allocations.push(args[0]);
            super(...args);
        }
    }
    context.Uint8Array = TrackingUint8Array;
    const callsBeforeHuge = inflateCalls;
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(huge));
    context.Uint8Array = NativeUint8Array;
    context.pako.Inflate = realInflate;

    assert.equal(result.status, 'not-found');
    assert.equal(result.metadata, undefined);
    assert.equal(inflateCalls - callsBeforeHuge, baselineCalls);
    assert.equal(allocations.some((size) => size >= 3 * 1024 * 1024), false);
});

test('PNG rejects zTXt compression methods other than 0', () => {
    const context = loadScannerContext();
    const png = makePng(context, { afterIdat: [ztxtChunk(context, 'parameters', 'ignored', { method: 1 })] });
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    assert.equal(result.status, 'not-found');
    assert.equal(result.metadata, undefined);
    assert.ok(result.diagnostics.some(entry => entry.detail === 'unsupported zTXt compression method'));
});

test('PNG zTXt input and output limits are diagnosed as resource-limit', () => {
    const context = loadScannerContext();
    const overInput = makePng(context, {
        afterIdat: [ztxtChunk(context, 'parameters', '', { compressed: Buffer.alloc(2 * 1024 * 1024 + 1) })],
    });
    const inputResult = context.scanPngMetadataBuffer(exactArrayBuffer(overInput));
    assert.equal(inputResult.status, 'not-found');
    assert.ok(inputResult.diagnostics.some(entry => entry.category === 'resource-limit' && entry.limit === 'MAX_ZTXT_COMPRESSED_BYTES'));

    const overOutput = makePng(context, {
        afterIdat: [ztxtChunk(context, 'parameters', '', {
            compressed: zlib.deflateSync(Buffer.alloc(8 * 1024 * 1024 + 1)),
        })],
    });
    const outputResult = context.scanPngMetadataBuffer(exactArrayBuffer(overOutput));
    assert.equal(outputResult.status, 'not-found');
    assert.ok(outputResult.diagnostics.some(entry => entry.category === 'resource-limit' && entry.limit === 'MAX_TEXT_CHUNK_BYTES'));
});

test('PNG zTXt CRC mismatch follows the existing text-chunk discard rule', () => {
    const context = loadScannerContext();
    const data = Buffer.concat([
        Buffer.from('parameters\0\0', 'latin1'),
        zlib.deflateSync(Buffer.from('crc-test', 'latin1')),
    ]);
    const png = makePng(context, { afterIdat: [pngChunk(context, 'zTXt', data, 0)] });
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    assert.equal(result.status, 'not-found');
    assert.equal(result.metadata, undefined);
    assert.ok(result.diagnostics.some(entry => entry.detail === 'text chunk CRC mismatch'));
});

test('existing tEXt value wins over zTXt regardless of chunk order', () => {
    const context = loadScannerContext();
    for (const ztxtFirst of [true, false]) {
        const chunks = [
            textChunk(context, 'parameters', 'existing'),
            ztxtChunk(context, 'parameters', 'ztext'),
        ];
        if (!ztxtFirst) chunks.reverse();
        const png = makePng(context, { afterIdat: chunks });
        const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
        assert.equal(result.status, 'normal');
        assert.equal(result.metadata.parameters, 'existing');
    }
});

test('zTXt keyword pre-read works across stream push boundaries', async () => {
    const context = loadScannerContext();
    const png = makePng(context, { afterIdat: [ztxtChunk(context, 'parameters', 'streamed ztext')] });
    const result = await context.scanPngMetadataStream(mockStream(png, [1, 2, 3, 5, 7, 11, 13, 17]));
    assert.equal(result.status, 'normal');
    assert.equal(result.metadata.parameters, 'streamed ztext');
});
