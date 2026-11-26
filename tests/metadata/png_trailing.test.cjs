const test = require('node:test');
const assert = require('node:assert/strict');
const {
    loadScannerContext,
    exactArrayBuffer,
    makePng,
    pngChunk,
    textChunk,
    ztxtChunk,
    tiffWithTags,
    mockStream,
} = require('./phase3_helpers.cjs');

function scan(context, png) {
    return context.scanPngMetadataBuffer(exactArrayBuffer(png));
}

test('buffer scanning reads complete trailing tEXt and zTXt chunks after IEND', () => {
    const context = loadScannerContext();
    const trailing = Buffer.concat([
        textChunk(context, 'parameters', 'trailing text'),
        ztxtChunk(context, 'Comment', 'trailing ztext'),
    ]);
    const result = scan(context, makePng(context, { trailing }));
    assert.equal(result.status, 'normal');
    assert.equal(result.metadata.parameters, 'trailing text');
    assert.equal(result.metadata.Comment, 'trailing ztext');
});

test('body metadata wins over trailing metadata for the same key', () => {
    const context = loadScannerContext();
    const png = makePng(context, {
        afterIdat: [textChunk(context, 'parameters', 'body')],
        trailing: textChunk(context, 'parameters', 'trailing'),
    });
    const result = scan(context, png);
    assert.equal(result.metadata.parameters, 'body');
});

test('trailing framing failures are ignored and do not turn the IEND result into an error', () => {
    const context = loadScannerContext();
    const malformed = Buffer.from('not a png chunk');
    const result = scan(context, makePng(context, { trailing: malformed }));
    assert.equal(result.status, 'not-found');
    assert.equal(result.metadata, undefined);
});

test('trailing CRC mismatch is rejected for interpreted chunk types', () => {
    const context = loadScannerContext();
    const data = Buffer.concat([
        Buffer.from('parameters\0', 'latin1'),
        Buffer.from('bad crc', 'latin1'),
    ]);
    const badCrc = pngChunk(context, 'tEXt', data, 0);
    const result = scan(context, makePng(context, { trailing: badCrc }));
    assert.equal(result.status, 'not-found');
    assert.equal(result.metadata, undefined);
});

test('non-target trailing chunks are skipped and later target chunks are still read', () => {
    const context = loadScannerContext();
    const trailing = Buffer.concat([
        pngChunk(context, 'IDAT', Buffer.alloc(0)),
        pngChunk(context, 'tIME', Buffer.alloc(7)),
        textChunk(context, 'parameters', 'after skipped chunks'),
    ]);
    const result = scan(context, makePng(context, { trailing }));
    assert.equal(result.metadata.parameters, 'after skipped chunks');
});

test('trailing zTXt uses the same allow-list gate', () => {
    const context = loadScannerContext();
    const allowed = scan(context, makePng(context, {
        trailing: ztxtChunk(context, 'prompt', 'allowed trailing'),
    }));
    assert.equal(allowed.metadata.prompt, 'allowed trailing');

    const denied = scan(context, makePng(context, {
        trailing: ztxtChunk(context, 'Other', 'denied trailing'),
    }));
    assert.equal(denied.status, 'not-found');
    assert.equal(denied.metadata, undefined);
});

test('trailing eXIf uses the body prefix limit', () => {
    const context = loadScannerContext();
    const shortExif = tiffWithTags({ description: 'trailing exif' });
    const shortResult = scan(context, makePng(context, {
        trailing: pngChunk(context, 'eXIf', shortExif),
    }));
    assert.equal(shortResult.metadata.Description, 'trailing exif');

    const largeExif = tiffWithTags({ description: 'x'.repeat(80 * 1024) });
    const largeResult = scan(context, makePng(context, {
        trailing: pngChunk(context, 'eXIf', largeExif),
    }));
    assert.equal(largeResult.status, 'normal');
    assert.equal(largeResult.metadataPartial, true);
    assert.equal(Object.hasOwn(largeResult.metadata, 'metadataPartial'), false);
});

test('trailing inspection stops at 1 MiB', () => {
    const context = loadScannerContext();
    const tooFar = Buffer.concat([
        Buffer.alloc(1024 * 1024),
        textChunk(context, 'parameters', 'too far'),
    ]);
    const result = scan(context, makePng(context, { trailing: tooFar }));
    assert.equal(result.status, 'not-found');
    assert.equal(result.metadata, undefined);
});

test('stream scanning reads suffix in the same push but not a later push', async () => {
    const context = loadScannerContext();
    const base = makePng(context);
    const trailing = textChunk(context, 'parameters', 'same push');
    const all = Buffer.concat([base, trailing]);
    const samePush = await context.scanPngMetadataStream(mockStream(all, all.length));
    assert.equal(samePush.metadata.parameters, 'same push');

    const nextPush = await context.scanPngMetadataStream(mockStream(all, [base.length, trailing.length]));
    assert.equal(nextPush.status, 'not-found');
    assert.equal(nextPush.metadata, undefined);
});
