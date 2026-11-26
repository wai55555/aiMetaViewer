const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const {
    loadScannerContext,
    exactArrayBuffer,
    makePng,
    pngChunk,
    textChunk,
    tiffWithTags,
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

function makeRawRows(width, height, colorType = 6, seed = 1) {
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
    const rowBytes = width * channels;
    const raw = Buffer.alloc(height * (rowBytes + 1));
    for (let y = 0; y < height; y += 1) {
        const start = y * (rowBytes + 1);
        raw[start] = 0;
        for (let x = 0; x < rowBytes; x += 1) {
            raw[start + 1 + x] = (x * 31 + y * 17 + seed) & 0xff;
        }
    }
    return raw;
}

function splitIdatPng(context, {
    width,
    height,
    colorType = 6,
    compressed,
    splitAt,
    secondCrc = null,
    afterIdat = [],
}) {
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'IHDR', makeIhdr(width, height, colorType)),
        pngChunk(context, 'IDAT', compressed.subarray(0, splitAt)),
        pngChunk(context, 'IDAT', compressed.subarray(splitAt), secondCrc),
        ...afterIdat,
        pngChunk(context, 'IEND', Buffer.alloc(0)),
    ]);
}

function stealthPng(context, text = '{"prompt":"phase5 stealth"}', beforeIdat = []) {
    const width = 64;
    const height = 64;
    const rowBytes = width * 4;
    const raw = Buffer.alloc(height * (rowBytes + 1));
    const signature = Buffer.from('stealth_pnginfo', 'ascii');
    const payload = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(signature.length + 4);
    signature.copy(header, 0);
    header.writeUInt32BE(payload.length * 8, signature.length);
    const full = Buffer.concat([header, payload]);
    for (let bit = 0; bit < full.length * 8; bit += 1) {
        const value = (full[bit >>> 3] >>> (7 - (bit & 7))) & 1;
        const x = Math.floor(bit / height);
        const y = bit % height;
        if (x >= width) break;
        const offset = y * (rowBytes + 1) + 1 + x * 4 + 3;
        raw[offset] = (raw[offset] & 0xfe) | value;
    }
    return makePng(context, { width, height, colorType: 6, idat: zlib.deflateSync(raw), beforeIdat });
}

test('rejected Stealth candidates stop pixel work within the first-stage rows', () => {
    const context = loadScannerContext();
    const width = 8;
    const height = 10000;
    const compressed = zlib.deflateSync(makeRawRows(width, height, 6, 7));
    const png = splitIdatPng(context, {
        width,
        height,
        compressed,
        splitAt: Math.min(20 * 1024, compressed.length - 1),
    });
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    const stop = result.diagnostics.find(entry => entry.category === 'intentional-stealth-stop');
    assert.ok(stop);
    assert.ok(stop.decodedRows <= 160, `decodedRows=${stop.decodedRows}`);
});

test('matched Stealth candidates still decode and return metadata', () => {
    const context = loadScannerContext();
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(stealthPng(context)));
    assert.equal(result.status, 'stealth');
    assert.equal(result.metadata['Stealth PNG Info (Alpha)'], '{"prompt":"phase5 stealth"}');
});

test('Software-only metadata does not suppress Stealth and Stealth becomes the primary result', () => {
    const context = loadScannerContext();
    const withTextSoftware = stealthPng(context, 'NovelAI Diffusion V4.5 test payload', [
        textChunk(context, 'Software', 'Paint.NET'),
    ]);
    const textResult = context.scanPngMetadataBuffer(exactArrayBuffer(withTextSoftware));
    assert.equal(textResult.status, 'stealth');
    assert.deepEqual(Object.keys(textResult.metadata), ['Stealth PNG Info (Alpha)']);
    assert.match(textResult.metadata['Stealth PNG Info (Alpha)'], /NovelAI Diffusion V4\.5/);

    const withExifSoftware = stealthPng(context, 'NovelAI Diffusion V4.5 test payload', [
        pngChunk(context, 'eXIf', tiffWithTags({ software: 'Paint.NET' })),
    ]);
    const exifResult = context.scanPngMetadataBuffer(exactArrayBuffer(withExifSoftware));
    assert.equal(exifResult.status, 'stealth');
    assert.deepEqual(Object.keys(exifResult.metadata), ['Stealth PNG Info (Alpha)']);

    const softwareOnly = makePng(context, {
        width: 8,
        height: 8,
        idat: zlib.deflateSync(Buffer.alloc(8 * (8 * 4 + 1))),
        beforeIdat: [textChunk(context, 'Software', 'Paint.NET')],
    });
    const softwareOnlyResult = context.scanPngMetadataBuffer(exactArrayBuffer(softwareOnly));
    assert.equal(softwareOnlyResult.status, 'normal');
    assert.equal(softwareOnlyResult.metadata.Software, 'Paint.NET');
});

test('debugAllDetections returns normal and Stealth carriers without changing normal priority', () => {
    const context = loadScannerContext();
    const png = stealthPng(context, '{"prompt":"debug stealth"}', [
        textChunk(context, 'Software', 'Paint.NET'),
        textChunk(context, 'Description', 'normal metadata'),
    ]);
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png), { debugAllDetections: true });
    assert.equal(result.status, 'normal');
    assert.equal(result.metadata.Description, 'normal metadata');
    assert.equal(result.metadata.Software, 'Paint.NET');
    assert.equal(result.metadata['Stealth PNG Info (Alpha)'], '{"prompt":"debug stealth"}');
    const debug = result.debug;
    assert.equal(debug.enabled, true);
    assert.ok(debug.carriers.some(carrier => carrier.carrier === 'tEXt' && carrier.key === 'Description'));
    assert.ok(debug.carriers.some(carrier => carrier.carrier === 'stealth' && carrier.outcome === 'matched'));
});

test('debugAllDetections leaves normal-mode suppression unchanged', () => {
    const context = loadScannerContext();
    const png = stealthPng(context, '{"prompt":"normal suppression"}', [
        textChunk(context, 'Description', 'normal metadata'),
    ]);
    const normal = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    assert.equal(normal.status, 'normal');
    assert.equal(normal.metadata['Stealth PNG Info (Alpha)'], undefined);
    assert.equal(normal.debug, undefined);
});

test('Software plus other normal metadata still follows normal-metadata priority', () => {
    const context = loadScannerContext();
    const png = stealthPng(context, 'NovelAI Diffusion V4.5 test payload', [
        textChunk(context, 'Software', 'Paint.NET'),
        textChunk(context, 'Description', 'non-software metadata'),
    ]);
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    assert.equal(result.status, 'normal');
    assert.equal(result.metadata.Software, 'Paint.NET');
    assert.equal(result.metadata.Description, 'non-software metadata');
    assert.equal(Object.hasOwn(result.metadata, 'Stealth PNG Info (Alpha)'), false);
});

test('normal metadata suppresses Stealth decode and zlib validation before IDAT', () => {
    const context = loadScannerContext();
    const png = makePng(context, {
        width: 8,
        height: 8,
        beforeIdat: [pngChunk(context, 'eXIf', tiffWithTags({ description: 'normal metadata' }))],
        idat: Buffer.from('not a zlib stream'),
        afterIdat: [textChunk(context, 'Comment', 'after invalid zlib')],
    });
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    assert.equal(result.status, 'normal');
    assert.equal(result.metadata.Description, 'normal metadata');
    assert.equal(result.metadata.Comment, 'after invalid zlib');
});

test('rejected Stealth candidates switch the rest of IDAT to framing-only', () => {
    const context = loadScannerContext();
    const width = 8;
    const height = 10000;
    const compressed = Buffer.from(zlib.deflateSync(makeRawRows(width, height, 6, 11)));
    compressed[compressed.length - 1] ^= 0xff;
    const png = splitIdatPng(context, {
        width,
        height,
        compressed,
        splitAt: Math.min(20 * 1024, compressed.length - 1),
        afterIdat: [textChunk(context, 'Comment', 'after rejected stealth')],
    });
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    assert.equal(result.status, 'normal');
    assert.equal(result.metadata.Comment, 'after rejected stealth');
    assert.ok(result.diagnostics.some(entry => entry.category === 'intentional-stealth-stop'));
});

test('zlib-only corruption becomes not-found when no metadata is present', () => {
    const context = loadScannerContext();
    const unsupported = makePng(context, {
        width: 8,
        height: 8,
        colorType: 0,
        idat: Buffer.from('not a zlib stream'),
    });
    assert.equal(context.scanPngMetadataBuffer(exactArrayBuffer(unsupported)).status, 'not-found');

    const width = 8;
    const height = 10000;
    const compressed = Buffer.from(zlib.deflateSync(makeRawRows(width, height, 6, 13)));
    compressed[compressed.length - 1] ^= 0xff;
    const rejected = splitIdatPng(context, {
        width,
        height,
        compressed,
        splitAt: Math.min(20 * 1024, compressed.length - 1),
    });
    assert.equal(context.scanPngMetadataBuffer(exactArrayBuffer(rejected)).status, 'not-found');
});

test('unsupported pixel layouts and oversized Stealth candidates do not inflate IDAT', () => {
    const context = loadScannerContext();
    const unsupported = makePng(context, {
        width: 8,
        height: 8,
        colorType: 0,
        idat: Buffer.from('not a zlib stream'),
        afterIdat: [textChunk(context, 'Comment', 'unsupported layout')],
    });
    const unsupportedResult = context.scanPngMetadataBuffer(exactArrayBuffer(unsupported));
    assert.equal(unsupportedResult.status, 'normal');
    assert.equal(unsupportedResult.metadata.Comment, 'unsupported layout');
    assert.ok(unsupportedResult.diagnostics.some(entry => entry.category === 'unsupported-stealth'));

    const oversized = makePng(context, {
        width: 8193,
        height: 4096,
        colorType: 6,
        idat: Buffer.from('not a zlib stream'),
        afterIdat: [textChunk(context, 'Comment', 'oversized')],
    });
    const oversizedResult = context.scanPngMetadataBuffer(exactArrayBuffer(oversized));
    assert.equal(oversizedResult.status, 'normal');
    assert.equal(oversizedResult.metadata.Comment, 'oversized');
    const limitDiagnostic = oversizedResult.diagnostics.find(entry =>
        entry.category === 'unsupported-stealth' && entry.observed?.limit === 33554432
    );
    assert.ok(limitDiagnostic);
    assert.equal(limitDiagnostic.observed.pixelCount, 8193 * 4096);
});

test('chunk CRC mismatch remains invalid-png in all three framing-only cases', () => {
    const context = loadScannerContext();

    // Replace the IDAT chunk's CRC with an invalid value while keeping framing valid.
    const normalWithBadCrc = (() => {
        const ihdr = pngChunk(context, 'IHDR', makeIhdr(8, 8, 6));
        const exif = pngChunk(context, 'eXIf', tiffWithTags({ description: 'normal' }));
        const idat = pngChunk(context, 'IDAT', Buffer.from('not zlib'), 0);
        return Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            ihdr, exif, idat, pngChunk(context, 'IEND', Buffer.alloc(0)),
        ]);
    })();
    assert.equal(context.scanPngMetadataBuffer(exactArrayBuffer(normalWithBadCrc)).status, 'invalid-png');

    const unsupported = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'IHDR', makeIhdr(8, 8, 0)),
        pngChunk(context, 'IDAT', Buffer.from('not zlib'), 0),
        pngChunk(context, 'IEND', Buffer.alloc(0)),
    ]);
    assert.equal(context.scanPngMetadataBuffer(exactArrayBuffer(unsupported)).status, 'invalid-png');

    const width = 8;
    const height = 10000;
    const compressed = zlib.deflateSync(makeRawRows(width, height, 6, 12));
    const rejected = splitIdatPng(context, {
        width,
        height,
        compressed,
        splitAt: Math.min(20 * 1024, compressed.length - 1),
        secondCrc: 0,
    });
    assert.equal(context.scanPngMetadataBuffer(exactArrayBuffer(rejected)).status, 'invalid-png');
});

test('Stealth safety limits remain at the Phase 5 values', () => {
    const context = loadScannerContext();
    assert.equal(context.PNG_METADATA_SCANNER_CONSTANTS.MAX_STEALTH_PIXELS, 33554432);
    assert.equal(context.PNG_METADATA_SCANNER_CONSTANTS.MAX_STEALTH_HEADER_ROWS, 160);
    assert.equal(context.PNG_METADATA_SCANNER_CONSTANTS.MAX_DECODED_BYTES, 512 * 1024 * 1024);
});
