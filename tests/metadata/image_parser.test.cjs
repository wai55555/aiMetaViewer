const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const parserSource = fs.readFileSync(path.join(__dirname, '../../extension/parser.js'), 'utf8');

function parserContext() {
    const context = vm.createContext({ console, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView });
    context.window = context;
    vm.runInContext(parserSource, context, { filename: 'parser.js' });
    return context;
}

function exactArrayBuffer(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function write16(buffer, offset, value, littleEndian) {
    if (littleEndian) buffer.writeUInt16LE(value, offset);
    else buffer.writeUInt16BE(value, offset);
}

function write32(buffer, offset, value, littleEndian) {
    if (littleEndian) buffer.writeUInt32LE(value, offset);
    else buffer.writeUInt32BE(value, offset);
}

function makeTiff({ littleEndian = true, description = null, userComment = null, fakeTagBytes = false, pointerType = 4 } = {}) {
    const descBytes = description === null ? null : Buffer.from(`${description}\0`, 'utf8');
    const commentBytes = userComment === null
        ? null
        : Buffer.concat([Buffer.from('ASCII\0\0\0', 'latin1'), Buffer.from(userComment, 'utf8')]);
    const mainCount = (descBytes ? 1 : 0) + (commentBytes ? 1 : 0);
    const ifd0Offset = 8;
    const ifd0End = ifd0Offset + 2 + mainCount * 12 + 4;
    const exifIfdOffset = commentBytes ? ifd0End : 0;
    const exifIfdEnd = commentBytes ? exifIfdOffset + 2 + 12 + 4 : ifd0End;
    const descOffset = exifIfdEnd;
    const commentOffset = descOffset + (descBytes ? descBytes.length : 0);
    const fakeBytes = fakeTagBytes ? Buffer.from([0x0e, 0x01, 2, 0, 12, 0, 0, 0, 40, 0, 0, 0, ...Buffer.from('not an IFD entry')]) : Buffer.alloc(0);
    const buffer = Buffer.alloc(commentOffset + (commentBytes ? commentBytes.length : 0) + fakeBytes.length);
    buffer.write(littleEndian ? 'II' : 'MM', 0, 'ascii');
    write16(buffer, 2, 42, littleEndian);
    write32(buffer, 4, ifd0Offset, littleEndian);
    write16(buffer, ifd0Offset, mainCount, littleEndian);

    let entry = ifd0Offset + 2;
    if (descBytes) {
        write16(buffer, entry, 0x010e, littleEndian);
        write16(buffer, entry + 2, 2, littleEndian);
        write32(buffer, entry + 4, descBytes.length, littleEndian);
        write32(buffer, entry + 8, descOffset, littleEndian);
        entry += 12;
    }
    if (commentBytes) {
        write16(buffer, entry, 0x8769, littleEndian);
        write16(buffer, entry + 2, pointerType, littleEndian);
        write32(buffer, entry + 4, 1, littleEndian);
        write32(buffer, entry + 8, exifIfdOffset, littleEndian);
    }
    write32(buffer, ifd0Offset + 2 + mainCount * 12, 0, littleEndian);

    if (commentBytes) {
        write16(buffer, exifIfdOffset, 1, littleEndian);
        write16(buffer, exifIfdOffset + 2, 0x9286, littleEndian);
        write16(buffer, exifIfdOffset + 4, 7, littleEndian);
        write32(buffer, exifIfdOffset + 6, commentBytes.length, littleEndian);
        write32(buffer, exifIfdOffset + 10, commentOffset, littleEndian);
        write32(buffer, exifIfdOffset + 14, 0, littleEndian);
        commentBytes.copy(buffer, commentOffset);
    }
    if (descBytes) descBytes.copy(buffer, descOffset);
    if (fakeBytes.length) fakeBytes.copy(buffer, commentOffset + (commentBytes ? commentBytes.length : 0));
    return buffer;
}

function be32(value) {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value);
    return result;
}

function le32(value) {
    const result = Buffer.alloc(4);
    result.writeUInt32LE(value);
    return result;
}

function be16(value) {
    const result = Buffer.alloc(2);
    result.writeUInt16BE(value);
    return result;
}

function pngChunk(context, type, data, crcOverride = null) {
    const typeBytes = Buffer.from(type, 'ascii');
    const payload = Buffer.from(data);
    const crcInput = Buffer.concat([typeBytes, payload]);
    const crcValue = crcOverride === null
        ? context.computeCrc32(crcInput)
        : crcOverride;
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crcValue >>> 0);
    return Buffer.concat([be32(payload.length), typeBytes, payload, crc]);
}

function riffChunk(type, data) {
    const payload = Buffer.from(data);
    return Buffer.concat([
        Buffer.from(type, 'ascii'),
        le32(payload.length),
        payload,
        payload.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0),
    ]);
}

function makeWebp(chunks) {
    const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks]);
    return Buffer.concat([Buffer.from('RIFF', 'ascii'), le32(body.length), body]);
}

function isoBox(type, payload) {
    const body = Buffer.from(payload);
    return Buffer.concat([be32(body.length + 8), Buffer.from(type, 'ascii'), body]);
}

function makeAvifWithExif(tiff) {
    const itemBytes = Buffer.concat([be32(0), Buffer.from(tiff)]);
    const infe = isoBox('infe', Buffer.concat([
        Buffer.from([2, 0, 0, 0]),
        be16(1),
        be16(0),
        Buffer.from('Exif\0', 'ascii'),
    ]));
    const iinf = isoBox('iinf', Buffer.concat([
        Buffer.from([0, 0, 0, 0]),
        be16(1),
        infe,
    ]));
    const iloc = isoBox('iloc', Buffer.concat([
        Buffer.from([1, 0, 0, 0, 0x44, 0x40]),
        be16(1),
        be16(1),
        be16(1),
        be16(0),
        be32(0),
        be16(1),
        be32(0),
        be32(itemBytes.length),
    ]));
    const meta = isoBox('meta', Buffer.concat([
        Buffer.alloc(4),
        iinf,
        iloc,
        isoBox('idat', itemBytes),
    ]));
    const ftyp = isoBox('ftyp', Buffer.concat([
        Buffer.from('avif', 'ascii'),
        Buffer.alloc(4),
        Buffer.from('avif', 'ascii'),
    ]));
    return Buffer.concat([ftyp, meta]);
}

test('TIFF EXIF follows real IFD entries and respects both byte orders', () => {
    const context = parserContext();
    for (const littleEndian of [true, false]) {
        const tiff = makeTiff({ littleEndian, description: 'a quiet forest', userComment: '{"workflow":"comfy"}' });
        const metadata = context.extractExifPayload(tiff, { declaredLength: tiff.length });
        assert.equal(metadata.parserState, 'resolved');
        assert.equal(metadata.Description, 'a quiet forest');
        assert.equal(metadata.parameters, '{"workflow":"comfy"}');
    }
});

test('TIFF IFD-typed pointers reach nested EXIF directories', () => {
    const context = parserContext();
    const metadata = context.extractExifPayload(
        makeTiff({ userComment: '{"workflow":"ifd-pointer"}', pointerType: 13 }),
    );
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.parameters, '{"workflow":"ifd-pointer"}');
});

test('bytes that resemble EXIF tags outside an IFD are ignored', () => {
    const context = parserContext();
    const metadata = context.extractExifPayload(makeTiff({ fakeTagBytes: true }));
    assert.equal(metadata.parserState, 'empty-confirmed');
    assert.equal(metadata.Description, undefined);
    assert.equal(metadata.parameters, undefined);
});

test('truncated EXIF values stay unresolved and identify the required range', () => {
    const context = parserContext();
    const tiff = makeTiff({ description: 'value beyond the available prefix' });
    const truncated = tiff.subarray(0, 26);
    const metadata = context.extractExifPayload(truncated, { declaredLength: tiff.length });
    assert.equal(metadata.parserState, 'unresolved');
    assert.equal(metadata.suggestedSize, tiff.length - 1);
});

test('complete malformed EXIF is terminal and does not hide later valid metadata', () => {
    const context = parserContext();
    const malformedTiff = Buffer.from(makeTiff({ description: 'discarded malformed value' }));
    malformedTiff[0] = 0x58;
    assert.equal(context.extractExifPayload(malformedTiff).parserState, 'invalid');

    const validTiff = makeTiff({ description: 'later valid metadata' });
    const invalidExif = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), malformedTiff]);
    const validExif = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), validTiff]);
    const jpegSegment = (payload) => Buffer.concat([
        Buffer.from([0xff, 0xe1]),
        Buffer.from([((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff]),
        payload,
    ]);
    const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        jpegSegment(invalidExif),
        jpegSegment(validExif),
        Buffer.from([0xff, 0xda, 0, 2]),
    ]);
    assert.equal(context.extractMetadata(exactArrayBuffer(jpeg), { format: 'jpeg' }).Description, 'later valid metadata');

    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'eXIf', malformedTiff),
        pngChunk(context, 'eXIf', validTiff),
        pngChunk(context, 'IEND', Buffer.alloc(0)),
    ]);
    assert.equal(context.extractMetadata(exactArrayBuffer(png), { format: 'png' }).Description, 'later valid metadata');

    const webp = makeWebp([riffChunk('EXIF', malformedTiff), riffChunk('EXIF', validTiff)]);
    assert.equal(context.extractMetadata(exactArrayBuffer(webp), { format: 'webp', inputComplete: true }).Description, 'later valid metadata');
    const scanner = context.createWebpMetadataStreamScanner();
    scanner.push(webp);
    assert.equal(scanner.finish().state, 'resolved');
});

test('JPEG APP1, PNG eXIf, WebP EXIF, and AVIF Exif items share the structural TIFF reader', () => {
    const context = parserContext();
    const tiff = makeTiff({ description: 'shared description' });
    const exifPayload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);

    const app1 = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
        Buffer.from([((exifPayload.length + 2) >> 8) & 0xff, (exifPayload.length + 2) & 0xff]),
        exifPayload,
        Buffer.from([0xff, 0xda, 0, 2]),
    ]);
    assert.equal(context.extractMetadata(exactArrayBuffer(app1), { format: 'jpeg' }).Description, 'shared description');

    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'eXIf', tiff),
        pngChunk(context, 'IEND', Buffer.alloc(0)),
    ]);
    assert.equal(context.extractMetadata(exactArrayBuffer(png), { format: 'png' }).Description, 'shared description');

    const webp = makeWebp([riffChunk('EXIF', exifPayload)]);
    assert.equal(context.extractMetadata(exactArrayBuffer(webp), { format: 'webp', inputComplete: true }).Description, 'shared description');

    const avif = makeAvifWithExif(tiff);
    const avifMetadata = context.extractMetadata(exactArrayBuffer(avif), { format: 'avif', inputComplete: true });
    assert.equal(avifMetadata.parserState, 'resolved', `${JSON.stringify(avifMetadata)} ${avifMetadata.parserReason || ''} ${avifMetadata.suggestedSize || ''}`);
    assert.equal(avifMetadata.Description, 'shared description');
});

test('WebP stream scanner reaches EXIF after more than 2 MiB of VP8 data', () => {
    const context = parserContext();
    const webp = makeWebp([
        riffChunk('VP8 ', Buffer.alloc(2 * 1024 * 1024 + 17, 0x33)),
        riffChunk('EXIF', Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), makeTiff({ description: 'after VP8' })])),
    ]);
    const scanner = context.createWebpMetadataStreamScanner({ maxMetadataBytes: 64 * 1024 });
    for (let offset = 0; offset < webp.length; offset += 7919) {
        scanner.push(webp.subarray(offset, Math.min(webp.length, offset + 7919)));
    }
    const result = scanner.finish();
    assert.equal(result.complete, true);
    assert.equal(result.state, 'resolved');
    assert.equal(result.metadata.Description, 'after VP8');
    assert.equal(result.bytesRead, webp.length);
});

test('WebP scanning preserves chunks present beyond an undersized RIFF length', () => {
    const context = parserContext();
    const webp = makeWebp([
        riffChunk('VP8 ', Buffer.alloc(32, 0x33)),
        riffChunk('EXIF', makeTiff({ description: 'beyond RIFF declaration' })),
    ]);
    webp.writeUInt32LE(12, 4);

    const direct = context.extractMetadata(exactArrayBuffer(webp), { format: 'webp', inputComplete: true });
    assert.equal(direct.parserState, 'resolved');
    assert.equal(direct.Description, 'beyond RIFF declaration');
    const directPartial = context.extractMetadata(exactArrayBuffer(webp), { format: 'webp', inputComplete: false });
    assert.equal(directPartial.parserState, 'resolved');
    assert.equal(directPartial.metadataPartial, true);

    const scanner = context.createWebpMetadataStreamScanner();
    scanner.push(webp);
    const streamed = scanner.finish();
    assert.equal(streamed.complete, true);
    assert.equal(streamed.state, 'resolved');
    assert.equal(streamed.metadata.Description, 'beyond RIFF declaration');

    const partialScanner = context.createWebpMetadataStreamScanner();
    partialScanner.push(webp);
    const partial = partialScanner.finish({ inputComplete: false });
    assert.equal(partial.complete, false);
    assert.equal(partial.state, 'resolved');
    assert.equal(partial.metadataPartial, true);
});

test('WebP scanner confirms an empty EXIF IFD after a large EXIF chunk prefix', () => {
    const context = parserContext();
    const emptyIfd = Buffer.alloc(14);
    emptyIfd.write('II', 0, 'ascii');
    emptyIfd.writeUInt16LE(42, 2);
    emptyIfd.writeUInt32LE(8, 4);
    emptyIfd.writeUInt16LE(0, 8);
    emptyIfd.writeUInt32LE(0, 10);
    const largeExif = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), emptyIfd, Buffer.alloc(128 * 1024)]);
    const webp = makeWebp([riffChunk('EXIF', largeExif)]);
    const scanner = context.createWebpMetadataStreamScanner({ maxMetadataBytes: 64 * 1024 });
    const result = scanner.push(webp).state === 'invalid' ? scanner.snapshot() : scanner.finish();
    assert.equal(result.complete, true);
    assert.equal(result.state, 'empty-confirmed');
    assert.deepEqual(Object.keys(result.metadata), []);
});

test('WebP truncation remains unresolved instead of confirming empty', () => {
    const context = parserContext();
    const webp = makeWebp([riffChunk('VP8 ', Buffer.alloc(64, 0))]);
    const scanner = context.createWebpMetadataStreamScanner();
    scanner.push(webp.subarray(0, webp.length - 5));
    const result = scanner.finish();
    assert.equal(result.complete, false);
    assert.equal(result.state, 'unresolved');
});

test('truncated JPEG, PNG, WebP, and AVIF EXIF containers remain unresolved', () => {
    const context = parserContext();
    const tiff = makeTiff({ description: 'metadata that is cut off' });
    const exifPayload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
    const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
        Buffer.from([((exifPayload.length + 2) >> 8) & 0xff, (exifPayload.length + 2) & 0xff]),
        exifPayload.subarray(0, 20),
    ]);
    assert.equal(context.extractMetadata(exactArrayBuffer(jpeg), { format: 'jpeg', inputComplete: false }).parserState, 'unresolved');

    const pngHead = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        be32(tiff.length),
        Buffer.from('eXIf', 'ascii'),
        tiff.subarray(0, 20),
    ]);
    assert.equal(context.extractMetadata(exactArrayBuffer(pngHead), { format: 'png' }).parserState, 'unresolved');

    const fullWebp = makeWebp([riffChunk('EXIF', exifPayload)]);
    const webpScanner = context.createWebpMetadataStreamScanner();
    webpScanner.push(fullWebp.subarray(0, fullWebp.length - 20));
    assert.equal(webpScanner.finish().state, 'unresolved');

    const fullAvif = makeAvifWithExif(tiff);
    assert.equal(context.extractMetadata(exactArrayBuffer(fullAvif.subarray(0, fullAvif.length - 1)), {
        format: 'avif',
        inputComplete: false,
    }).parserState, 'unresolved');
});

test('JPEG ignores EXIF-like bytes in an unrelated comment segment', () => {
    const context = parserContext();
    const comment = Buffer.from('comment with tag bytes: \x0e\x01 and prompt text', 'latin1');
    const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xfe]),
        Buffer.from([((comment.length + 2) >> 8) & 0xff, (comment.length + 2) & 0xff]),
        comment,
        Buffer.from([0xff, 0xda, 0, 2]),
    ]);
    const metadata = context.extractMetadata(exactArrayBuffer(jpeg), { format: 'jpeg' });
    assert.equal(metadata.parserState, 'empty-confirmed');
    assert.equal(metadata.Description, undefined);
});

test('PNG ignores metadata-looking bytes embedded inside an IDAT chunk', () => {
    const context = parserContext();
    const innerPayload = Buffer.from('parameters\0forged prompt', 'latin1');
    const fakeTextChunk = Buffer.concat([
        be32(innerPayload.length),
        Buffer.from('tEXt', 'ascii'),
        innerPayload,
        Buffer.alloc(4),
    ]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'IHDR', ihdr),
        pngChunk(context, 'IDAT', fakeTextChunk),
        pngChunk(context, 'IEND', Buffer.alloc(0)),
    ]);
    const metadata = context.extractMetadata(exactArrayBuffer(png), { format: 'png' });
    assert.equal(metadata.parserState, 'empty-confirmed');
    assert.equal(metadata.parameters, undefined);
});
