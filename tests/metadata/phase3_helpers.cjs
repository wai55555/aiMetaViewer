const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');

const repoRoot = path.resolve(__dirname, '../..');
const extensionDir = path.join(repoRoot, 'extension');

function loadScannerContext() {
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
        vm.runInContext(fs.readFileSync(path.join(extensionDir, file), 'utf8'), context, {
            filename: file,
        });
    }
    return context;
}

function loadParserContext() {
    const context = vm.createContext({
        console,
        TextDecoder,
        TextEncoder,
        Uint8Array,
        ArrayBuffer,
        DataView,
    });
    context.window = context;
    vm.runInContext(fs.readFileSync(path.join(extensionDir, 'parser.js'), 'utf8'), context, {
        filename: 'parser.js',
    });
    return context;
}

function exactArrayBuffer(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function be32(value) {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value >>> 0);
    return result;
}

function pngChunk(context, type, data, crcOverride = null) {
    const typeBytes = Buffer.from(type, 'ascii');
    const payload = Buffer.from(data);
    const crc = Buffer.alloc(4);
    const crcValue = crcOverride === null
        ? context.computeCrc32(Buffer.concat([typeBytes, payload]))
        : crcOverride;
    crc.writeUInt32BE(crcValue >>> 0);
    return Buffer.concat([be32(payload.length), typeBytes, payload, crc]);
}

function makePng(context, {
    width = 1,
    height = 1,
    colorType = 6,
    bitDepth = 8,
    idat = zlib.deflateSync(Buffer.alloc(5)),
    beforeIdat = [],
    afterIdat = [],
    omitIend = false,
    trailing = Buffer.alloc(0),
} = {}) {
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
    if (trailing.length > 0) chunks.push(trailing);
    return Buffer.concat(chunks);
}

function textChunk(context, keyword, text, type = 'tEXt') {
    return pngChunk(context, type, Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from(text, 'latin1'),
    ]));
}

function itxtChunk(context, keyword, text, { compressed = false, language = '', translated = '' } = {}) {
    const textBytes = Buffer.from(text, 'utf8');
    return pngChunk(context, 'iTXt', Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0]),
        Buffer.from([compressed ? 1 : 0, 0]),
        Buffer.from(language, 'ascii'),
        Buffer.from([0]),
        Buffer.from(translated, 'utf8'),
        Buffer.from([0]),
        compressed ? zlib.deflateSync(textBytes) : textBytes,
    ]));
}

function ztxtChunk(context, keyword, text, { method = 0, compressed = zlib.deflateSync(Buffer.from(text, 'latin1')) } = {}) {
    return pngChunk(context, 'zTXt', Buffer.concat([
        Buffer.from(keyword, 'latin1'),
        Buffer.from([0, method]),
        compressed,
    ]));
}

function tiffWithTags({
    software = null,
    description = null,
    userComment = null,
    littleEndian = true,
} = {}) {
    const values = [];
    const entries = [];
    let ifdOffset = 8;
    const valueOffsetBase = 8 + 2 + 12 * ((software === null ? 0 : 1) + (description === null ? 0 : 1) + (userComment === null ? 0 : 1)) + 4;
    let valueOffset = valueOffsetBase;
    const addEntry = (tag, bytes) => {
        entries.push({ tag, bytes, offset: valueOffset });
        valueOffset += bytes.length;
        values.push(bytes);
    };
    if (software !== null) addEntry(0x0131, Buffer.from(`${software}\0`, 'utf8'));
    if (description !== null) addEntry(0x010E, Buffer.from(`${description}\0`, 'utf8'));
    if (userComment !== null) {
        addEntry(0x9286, Buffer.concat([
            Buffer.from('ASCII\0\0\0', 'latin1'),
            Buffer.from(`${userComment}\0`, 'utf8'),
        ]));
    }
    const tiff = Buffer.alloc(valueOffset);
    tiff.write(littleEndian ? 'II' : 'MM', 0, 'ascii');
    const write16 = (value, offset) => littleEndian ? tiff.writeUInt16LE(value, offset) : tiff.writeUInt16BE(value, offset);
    const write32 = (value, offset) => littleEndian ? tiff.writeUInt32LE(value, offset) : tiff.writeUInt32BE(value, offset);
    write16(42, 2);
    write32(ifdOffset, 4);
    write16(entries.length, ifdOffset);
    entries.forEach((entry, index) => {
        const offset = ifdOffset + 2 + index * 12;
        write16(entry.tag, offset);
        write16(2, offset + 2);
        write32(entry.bytes.length, offset + 4);
        write32(entry.offset, offset + 8);
        entry.bytes.copy(tiff, entry.offset);
    });
    write32(0, ifdOffset + 2 + entries.length * 12);
    return tiff;
}

function jpegSegment(marker, payload) {
    const body = Buffer.from(payload);
    return Buffer.concat([
        Buffer.from([0xFF, marker, (body.length + 2) >> 8, (body.length + 2) & 0xFF]),
        body,
    ]);
}

function makeJpeg(segments, { sos = true } = {}) {
    return Buffer.concat([
        Buffer.from([0xFF, 0xD8]),
        ...segments,
        ...(sos ? [Buffer.from([0xFF, 0xDA, 0, 2])] : []),
    ]);
}

function xmpSegment(text) {
    return jpegSegment(0xE1, Buffer.concat([
        Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'ascii'),
        Buffer.from(text, 'utf8'),
    ]));
}

function extendedXmpSegment(text = 'extended') {
    return jpegSegment(0xE1, Buffer.concat([
        Buffer.from('http://ns.adobe.com/xmp/extension/\0', 'ascii'),
        Buffer.from(text, 'utf8'),
    ]));
}

function mockStream(bytes, chunkSizes = 4096) {
    return {
        getReader() {
            let offset = 0;
            let index = 0;
            return {
                async read() {
                    if (offset >= bytes.length) return { done: true };
                    const size = Array.isArray(chunkSizes) ? chunkSizes[index % chunkSizes.length] : chunkSizes;
                    const end = Math.min(bytes.length, offset + size);
                    const value = bytes.subarray(offset, end);
                    offset = end;
                    index += 1;
                    return { done: false, value };
                },
                async cancel() {},
                releaseLock() {},
            };
        },
    };
}

module.exports = {
    loadScannerContext,
    loadParserContext,
    exactArrayBuffer,
    makePng,
    pngChunk,
    textChunk,
    itxtChunk,
    ztxtChunk,
    tiffWithTags,
    jpegSegment,
    makeJpeg,
    xmpSegment,
    extendedXmpSegment,
    mockStream,
};
