const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

function scannerContext() {
    const context = vm.createContext({ console, TextDecoder, TextEncoder, Uint8Array, ArrayBuffer, DataView });
    context.window = context;
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../extension/parser.js'), 'utf8'), context, {
        filename: 'parser.js',
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../extension/pako.js'), 'utf8'), context, {
        filename: 'pako.js',
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../extension/png_metadata_scanner.js'), 'utf8'), context, {
        filename: 'png_metadata_scanner.js',
    });
    return context;
}

function exactArrayBuffer(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function be32(value) {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value);
    return result;
}

function pngChunk(context, type, data, crcOverride = null) {
    const typeBytes = Buffer.from(type, 'ascii');
    const payload = Buffer.from(data);
    const crcInput = Buffer.concat([typeBytes, payload]);
    const crcValue = crcOverride === null ? context.computeCrc32(crcInput) : crcOverride;
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crcValue >>> 0);
    return Buffer.concat([be32(payload.length), typeBytes, payload, crc]);
}

function makePng(context, { width = 1, height = 1, colorType = 6, bitDepth = 8, idat, afterIdat = [] }) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = bitDepth;
    ihdr[9] = colorType;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'IHDR', ihdr),
        pngChunk(context, 'IDAT', idat),
        ...afterIdat,
        pngChunk(context, 'IEND', Buffer.alloc(0)),
    ]);
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

test('PNG unsupported pixel layouts skip IDAT decode and still read later text chunks', () => {
    const context = scannerContext();
    const realInflate = context.pako.Inflate;
    let inflateCalls = 0;
    context.pako.Inflate = function countedInflate(...args) {
        inflateCalls += 1;
        return new realInflate(...args);
    };
    const png = makePng(context, {
        width: 8,
        height: 8,
        colorType: 0,
        idat: zlib.deflateSync(Buffer.alloc(8 * 9)),
        afterIdat: [pngChunk(context, 'tEXt', Buffer.from('Comment\0still found', 'latin1'))],
    });
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    context.pako.Inflate = realInflate;
    assert.equal(inflateCalls, 0);
    assert.equal(result.status, 'normal');
    assert.equal(result.metadata.Comment, 'still found');
});

test('PNG eXIf metadata stops Stealth candidate work and skips IDAT decode', () => {
    const context = scannerContext();
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'IHDR', ihdr),
        pngChunk(context, 'eXIf', tiffWithDescription('PNG EXIF prompt')),
        pngChunk(context, 'IDAT', zlib.deflateSync(Buffer.alloc(5))),
        pngChunk(context, 'IEND', Buffer.alloc(0)),
    ]);
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    assert.equal(result.status, 'normal');
    assert.equal(result.metadata.Description, 'PNG EXIF prompt');
});

test('PNG stops Stealth candidate work after rejection, skips IDAT decode, and scans later chunks', () => {
    const context = scannerContext();
    const height = 10000;
    const rawRows = Buffer.alloc(height * 5);
    const compressedRows = zlib.deflateSync(rawRows);
    // Keep the IDAT stream and CRC valid; only pixel-candidate work may stop early.
    const png = makePng(context, {
        width: 1,
        height,
        colorType: 6,
        idat: compressedRows,
        afterIdat: [pngChunk(context, 'tEXt', Buffer.from('Comment\0after skipped pixels', 'latin1'))],
    });
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    assert.equal(result.status, 'normal');
    assert.equal(result.metadata.Comment, 'after skipped pixels');
    assert.ok(result.diagnostics.some(entry => entry.category === 'intentional-stealth-stop'));
});

test('PNG reports invalid IDAT CRC even when EXIF metadata was already found', () => {
    const context = scannerContext();
    const compressedRow = zlib.deflateSync(Buffer.alloc(5));
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const exif = tiffWithDescription('metadata before IDAT');
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk(context, 'IHDR', ihdr),
        pngChunk(context, 'eXIf', exif),
        pngChunk(context, 'IDAT', compressedRow),
        pngChunk(context, 'IEND', Buffer.alloc(0)),
    ]);
    const idatCrcOffset = 8 + 25 + 12 + exif.length + 8 + compressedRow.length;
    png[idatCrcOffset] ^= 0xff;
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    assert.equal(result.status, 'invalid-png');
});

test('PNG reports partial EXIF metadata when its bounded chunk prefix cuts a value', () => {
    const context = scannerContext();
    const png = makePng(context, {
        width: 1,
        height: 1,
        colorType: 6,
        idat: zlib.deflateSync(Buffer.alloc(5)),
        afterIdat: [pngChunk(context, 'eXIf', tiffWithDescription('x'.repeat(80 * 1024)))],
    });
    const result = context.scanPngMetadataBuffer(exactArrayBuffer(png));
    assert.equal(result.status, 'normal');
    assert.equal(result.metadataPartial, true);
    assert.equal(Object.hasOwn(result.metadata, 'metadataPartial'), false);
});
