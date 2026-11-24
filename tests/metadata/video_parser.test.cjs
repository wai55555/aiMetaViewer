const test = require('node:test');
const assert = require('node:assert/strict');
const {
    detectVideoContainer,
    extractVideoMetadata,
    parseWebmTagsElement,
    readMp4BoxHeader,
    scanMp4VideoMetadata,
    scanWebmVideoMetadata,
} = require('../../extension/video_parser.js');

const utf8 = value => Buffer.from(value, 'utf8');
const uint32 = value => {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value);
    return result;
};
const uint64 = value => {
    const result = Buffer.alloc(8);
    result.writeBigUInt64BE(BigInt(value));
    return result;
};

function isoBox(type, payload, extended = false) {
    const body = Buffer.from(payload);
    const typeBytes = Buffer.isBuffer(type) ? type : Buffer.from(type, 'latin1');
    if (extended) return Buffer.concat([uint32(1), typeBytes, uint64(body.length + 16), body]);
    return Buffer.concat([uint32(body.length + 8), typeBytes, body]);
}

function makeMp4(comment) {
    const data = isoBox('data', Buffer.concat([uint32(1), uint32(0), utf8(comment)]));
    const item = isoBox('\u00A9cmt', data);
    const ilst = isoBox('ilst', item);
    const meta = isoBox('meta', Buffer.concat([Buffer.alloc(4), ilst]));
    const udta = isoBox('udta', meta);
    const moov = isoBox('moov', udta, true);
    const ftyp = isoBox('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1'));
    return Buffer.concat([ftyp, moov]);
}

function makeMdtaMp4(key, value) {
    const keyBytes = utf8(key);
    const keyEntry = Buffer.concat([uint32(keyBytes.length + 8), Buffer.from('mdta'), keyBytes]);
    const keys = isoBox('keys', Buffer.concat([Buffer.alloc(4), uint32(1), keyEntry]));
    const data = isoBox('data', Buffer.concat([uint32(1), uint32(0), utf8(value)]));
    const indexedItem = isoBox(Buffer.from([0, 0, 0, 1]), Buffer.concat([uint32(1), data]));
    const ilst = isoBox('ilst', indexedItem);
    const meta = isoBox('meta', Buffer.concat([Buffer.alloc(4), keys, ilst]));
    const moov = isoBox('moov', isoBox('udta', meta));
    const ftyp = isoBox('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1'));
    return Buffer.concat([ftyp, moov]);
}

function ebmlId(hex) { return Buffer.from(hex, 'hex'); }
function ebmlSize(size) {
    for (let length = 1; length <= 8; length++) {
        const maxValue = 2 ** (7 * length) - 1;
        if (size >= maxValue) continue;
        const bytes = Buffer.alloc(length);
        let value = size;
        for (let index = length - 1; index >= 0; index--) {
            bytes[index] = value & 0xFF;
            value = Math.floor(value / 256);
        }
        bytes[0] |= 1 << (8 - length);
        return bytes;
    }
    throw new RangeError('test EBML size is too large');
}
function ebmlElement(id, payload) {
    const body = Buffer.from(payload);
    return Buffer.concat([ebmlId(id), ebmlSize(body.length), body]);
}
function simpleTag(name, value) {
    return ebmlElement('67c8', Buffer.concat([
        ebmlElement('45a3', utf8(name)),
        ebmlElement('4487', utf8(value)),
    ]));
}
function webmTags(name, value) {
    return ebmlElement('1254c367', ebmlElement('7373', simpleTag(name, value)));
}
function webmTagsMany(entries) {
    return ebmlElement('1254c367', Buffer.concat(entries.map(([name, value]) =>
        ebmlElement('7373', simpleTag(name, value))
    )));
}
function makeWebmSeekHead(position) {
    const positionBytes = Buffer.from([(position >> 8) & 0xFF, position & 0xFF]);
    const seek = ebmlElement('4dbb', Buffer.concat([
        ebmlElement('53ab', ebmlId('1254c367')),
        ebmlElement('53ac', positionBytes),
    ]));
    return ebmlElement('114d9b74', seek);
}

test('MP4 extracts legacy comment metadata from an extended-size moov atom', () => {
    const payload = JSON.stringify({ prompt: { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'moonlit forest' } } } });
    const bytes = makeMp4(payload);
    assert.equal(detectVideoContainer(bytes), 'mp4');
    const metadata = extractVideoMetadata(bytes, { inputComplete: true, totalSize: bytes.length });
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.generator, 'ComfyUI');
    assert.deepEqual(metadata.prompt, JSON.parse(payload).prompt);
});

test('QuickTime legacy user-data comment parses 16-bit size and language entries', () => {
    const payload = JSON.stringify({ workflow: { nodes: [{ id: 1, type: 'CLIPTextEncode' }] } });
    const text = utf8(payload);
    const entryHeader = Buffer.alloc(4);
    entryHeader.writeUInt16BE(text.length + 4, 0);
    entryHeader.writeUInt16BE(0x7FFF, 2);
    const comment = isoBox('\u00A9cmt', Buffer.concat([entryHeader, text]));
    const bytes = Buffer.concat([
        isoBox('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
        isoBox('moov', isoBox('udta', comment)),
    ]);
    const metadata = extractVideoMetadata(bytes, { inputComplete: true });
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.generator, 'ComfyUI');
    assert.deepEqual(metadata.workflow, JSON.parse(payload).workflow);
});

test('QuickTime legacy user-data comment decodes MacRoman and BOM-marked UTF-16 text', () => {
    const makeComment = (textBytes, languageCode) => {
        const entryHeader = Buffer.alloc(4);
        entryHeader.writeUInt16BE(textBytes.length + 4, 0);
        entryHeader.writeUInt16BE(languageCode, 2);
        const comment = isoBox('\u00A9cmt', Buffer.concat([entryHeader, textBytes]));
        return Buffer.concat([
            isoBox('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
            isoBox('moov', isoBox('udta', comment)),
        ]);
    };
    const macRoman = extractVideoMetadata(makeComment(Buffer.from([0x63, 0x61, 0x66, 0x8E]), 0x7FFF), { inputComplete: true });
    const utf16 = extractVideoMetadata(makeComment(Buffer.from([0xFE, 0xFF, 0x00, 0x72, 0x00, 0x65, 0x00, 0x64]), 0x0409), { inputComplete: true });
    assert.equal(macRoman.Description, 'café');
    assert.equal(utf16.Description, 'red');
});

test('MP4 can parse a moov atom supplied as an absolute-offset tail range', () => {
    const bytes = makeMp4('plain generation note');
    const moovOffset = bytes.indexOf(Buffer.from('moov')) - 4;
    const tail = bytes.subarray(moovOffset);
    const metadata = extractVideoMetadata(tail, {
        format: 'mp4',
        startOffset: moovOffset,
        totalSize: bytes.length,
        inputComplete: true,
        atBoxBoundary: true,
    });
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.Description, 'plain generation note');
});

test('QuickTime files beginning with moov are recognized as ISO BMFF', () => {
    const source = makeMp4('quicktime note');
    const moovOffset = source.indexOf(Buffer.from('moov')) - 4;
    const quickTime = source.subarray(moovOffset);
    assert.equal(detectVideoContainer(quickTime), 'mp4');
    assert.equal(extractVideoMetadata(quickTime, { inputComplete: true, atBoxBoundary: true }).Description, 'quicktime note');
});

test('MP4 suffix parsing does not promote a byte-pattern inside an unknown range to a top-level atom', () => {
    const falseMoov = makeMp4('embedded marker');
    const metadata = extractVideoMetadata(falseMoov, {
        format: 'mp4',
        startOffset: 4096,
        totalSize: 4096 + falseMoov.length,
        inputComplete: true,
    });
    assert.equal(metadata.parserState, 'unresolved');
    assert.equal(metadata.Description, undefined);
});

test('MP4 parser reports the next verified top-level atom boundary after a large mdat', () => {
    const moov = makeMp4('actual metadata');
    const moovOffset = moov.indexOf(Buffer.from('moov')) - 4;
    const ftyp = isoBox('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1'));
    const mdat = isoBox('mdat', Buffer.alloc(64, 0x42));
    const file = Buffer.concat([
        ftyp,
        mdat,
        moov.subarray(moovOffset),
    ]);
    const head = file.subarray(0, 32);
    const metadata = extractVideoMetadata(head, { format: 'mp4', totalSize: file.length });
    assert.equal(metadata.parserState, 'unresolved');
    assert.equal(metadata.nextBoxOffset, ftyp.length + mdat.length);
});

test('MP4 full-buffer parser stops at its top-level atom count limit', () => {
    const file = Buffer.concat(Array.from({ length: 20001 }, () => isoBox('free', Buffer.alloc(0))));
    const metadata = extractVideoMetadata(file, { format: 'mp4', inputComplete: true, totalSize: file.length });
    assert.equal(metadata.parserState, 'resource-limit');
});

test('MP4 top-level scan skips embedded moov-looking bytes in mdat', async () => {
    const fake = makeMp4('embedded metadata');
    const fakeMoovOffset = fake.indexOf(Buffer.from('moov')) - 4;
    const fakeMoov = fake.subarray(fakeMoovOffset);
    const actual = makeMp4('top-level metadata');
    const actualMoovOffset = actual.indexOf(Buffer.from('moov')) - 4;
    const file = Buffer.concat([
        isoBox('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
        isoBox('mdat', Buffer.concat([Buffer.alloc(12, 0x41), fakeMoov])),
        actual.subarray(actualMoovOffset),
    ]);
    const metadata = await scanMp4VideoMetadata(
        async (offset, length) => file.subarray(offset, offset + length),
        file.length,
    );
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.Description, 'top-level metadata');

    const noTopLevelMoov = file.subarray(0, file.length - actual.length + actualMoovOffset);
    const empty = await scanMp4VideoMetadata(
        async (offset, length) => noTopLevelMoov.subarray(offset, offset + length),
        noTopLevelMoov.length,
    );
    assert.equal(empty.parserState, 'empty-confirmed');
    assert.equal(empty.Description, undefined);
});

test('MP4 range scan stops instead of confirming empty at its atom count limit', async () => {
    const file = Buffer.concat(Array.from({ length: 65 }, () => isoBox('free', Buffer.alloc(0))));
    const result = await scanMp4VideoMetadata(
        async (offset, length) => file.subarray(offset, offset + length),
        file.length,
        { maxBoxes: 64 }
    );
    assert.equal(result.parserState, 'resource-limit');
});

test('MP4 header reader validates 64-bit atom sizes against the file boundary', () => {
    const atom = isoBox('moov', Buffer.alloc(8), true);
    const valid = readMp4BoxHeader(atom.subarray(0, 16), { absoluteOffset: 100, totalSize: 100 + atom.length });
    const invalid = readMp4BoxHeader(atom.subarray(0, 16), { absoluteOffset: 100, totalSize: 100 + atom.length - 1 });
    assert.equal(valid.type, 'moov');
    assert.equal(valid.size, atom.length);
    assert.equal(valid.state, 'incomplete');
    assert.equal(invalid.state, 'invalid');
});

test('MP4 resolves indexed mdta keys and skips the item key index before data atoms', () => {
    const bytes = makeMdtaMp4('comfyui.prompt', 'a comet above the sea');
    const metadata = extractVideoMetadata(bytes, { inputComplete: true, totalSize: bytes.length });
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.prompt, 'a comet above the sea');
});

test('MP4 named ComfyUI JSON tags retain their original string fields without duplicates', () => {
    const prompt = '{ "1" : { "class_type" : "CLIPTextEncode", "inputs" : { "text" : "a quiet lake" } } }';
    const workflow = '{ "nodes" : [ { "id" : 1, "type" : "CLIPTextEncode" } ] }';
    const promptMetadata = extractVideoMetadata(makeMdtaMp4('prompt', prompt), { inputComplete: true });
    const workflowMetadata = extractVideoMetadata(makeMdtaMp4('workflow', workflow), { inputComplete: true });
    assert.equal(promptMetadata.generator, 'ComfyUI');
    assert.equal(promptMetadata.prompt, prompt);
    assert.equal(promptMetadata.workflow, undefined);
    assert.equal(workflowMetadata.generator, 'ComfyUI');
    assert.equal(workflowMetadata.workflow, workflow);
});

test('MP4 binary metadata values are not decoded as prompt text', () => {
    const binaryValue = Buffer.from('PROMPT\0hidden', 'latin1');
    const data = isoBox('data', Buffer.concat([uint32(13), uint32(0), binaryValue]));
    const ilst = isoBox('ilst', isoBox('\u00A9cmt', data));
    const meta = isoBox('meta', Buffer.concat([Buffer.alloc(4), ilst]));
    const bytes = Buffer.concat([
        isoBox('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
        isoBox('moov', isoBox('udta', meta)),
    ]);
    const metadata = extractVideoMetadata(bytes, { inputComplete: true });
    assert.equal(metadata.parserState, 'empty-confirmed');
    assert.equal(metadata.Description, undefined);
});

test('MP4 rejects an out-of-bounds atom and confirms complete files without metadata', () => {
    const broken = Buffer.concat([Buffer.from('ftyp'), uint32(1000), Buffer.from('moov')]);
    assert.equal(extractVideoMetadata(broken, { format: 'mp4', inputComplete: true }).parserState, 'unresolved');
    const empty = Buffer.concat([
        isoBox('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
        isoBox('moov', isoBox('trak', Buffer.alloc(0))),
    ]);
    assert.equal(extractVideoMetadata(empty, { inputComplete: true }).parserState, 'empty-confirmed');
});

test('MP4 does not schedule a follow-up range beyond the declared resource size', () => {
    const file = isoBox('mdat', Buffer.alloc(8));
    const metadata = extractVideoMetadata(file.subarray(0, 8), {
        format: 'mp4',
        totalSize: 12,
        inputComplete: false,
    });
    assert.equal(metadata.parserState, 'unresolved');
    assert.equal(metadata.nextBoxOffset, undefined);
});

test('MP4 malformed nested metadata remains unresolved instead of confirming empty', () => {
    const malformedItem = Buffer.concat([uint32(100), Buffer.from('\u00A9cmt', 'latin1')]);
    const ilst = isoBox('ilst', malformedItem);
    const meta = isoBox('meta', Buffer.concat([Buffer.alloc(4), ilst]));
    const bytes = Buffer.concat([
        isoBox('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
        isoBox('moov', isoBox('udta', meta)),
    ]);
    const metadata = extractVideoMetadata(bytes, { inputComplete: true });
    assert.equal(metadata.parserState, 'unresolved');
});

test('MP4 malformed legacy comment payload remains unresolved instead of confirming empty', () => {
    const malformedData = Buffer.concat([uint32(100), Buffer.from('data')]);
    const comment = isoBox('\u00A9cmt', malformedData);
    const bytes = Buffer.concat([
        isoBox('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
        isoBox('moov', isoBox('udta', comment)),
    ]);
    const metadata = extractVideoMetadata(bytes, { inputComplete: true });
    assert.equal(metadata.parserState, 'unresolved');
});

test('MP4 legacy comment and description data atoms reject truncated value headers', () => {
    for (const type of ['\u00A9cmt', 'desc']) {
        const data = isoBox('data', uint32(1));
        const bytes = Buffer.concat([
            isoBox('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')),
            isoBox('moov', isoBox('udta', isoBox(type, data))),
        ]);
        const metadata = extractVideoMetadata(bytes, { inputComplete: true });
        assert.equal(metadata.parserState, 'unresolved', `${type} should not confirm empty metadata`);
    }
});

test('WebM reads structured Tags after skipping a bounded Cluster payload', async () => {
    const tags = webmTags('PROMPT', 'a fox under snow');
    const info = ebmlElement('1549a966', Buffer.alloc(0));
    const cluster = ebmlElement('1f43b675', Buffer.alloc(96 * 1024, 0x41));
    const segmentChildren = Buffer.concat([info, cluster, tags]);
    const segment = ebmlElement('18538067', segmentChildren);
    const header = ebmlElement('1a45dfa3', ebmlElement('4282', utf8('webm')));
    const bytes = Buffer.concat([header, segment]);
    const readOffsets = [];
    const metadata = await scanWebmVideoMetadata(async (offset, length) => {
        readOffsets.push(offset);
        return bytes.subarray(offset, offset + length);
    }, bytes.length);

    assert.equal(detectVideoContainer(bytes), 'webm');
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.prompt, 'a fox under snow');
    assert.ok(readOffsets.length < 64);
    assert.ok(readOffsets.some(offset => offset > 64 * 1024), 'scanner should jump across the Cluster payload');
});

test('WebM unknown-size Cluster stays unresolved instead of confirming empty metadata', async () => {
    const unknownSizeCluster = Buffer.concat([ebmlId('1f43b675'), Buffer.from([0xFF])]);
    const tags = webmTags('PROMPT', 'after unknown-size cluster');
    const info = ebmlElement('1549a966', Buffer.alloc(0));
    const segment = ebmlElement('18538067', Buffer.concat([info, unknownSizeCluster, tags]));
    const header = ebmlElement('1a45dfa3', ebmlElement('4282', utf8('webm')));
    const bytes = Buffer.concat([header, segment]);

    const metadata = await scanWebmVideoMetadata(async (offset, length) =>
        bytes.subarray(offset, offset + length), bytes.length);

    assert.equal(metadata.parserState, 'unresolved');
    assert.equal(metadata.prompt, undefined);
});

test('WebM uses SeekHead positions to read Tags directly', async () => {
    const tags = webmTags('WORKFLOW', '{"nodes":[]}');
    const info = ebmlElement('1549a966', Buffer.alloc(0));
    let seekHead = makeWebmSeekHead(0);
    seekHead = makeWebmSeekHead(seekHead.length + info.length);
    const segment = ebmlElement('18538067', Buffer.concat([seekHead, info, tags]));
    const header = ebmlElement('1a45dfa3', ebmlElement('4282', utf8('webm')));
    const bytes = Buffer.concat([header, segment]);
    const reads = [];
    const metadata = await scanWebmVideoMetadata(async (offset, length) => {
        reads.push({ offset, length });
        return bytes.subarray(offset, offset + length);
    }, bytes.length);
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.workflow, '{"nodes":[]}');
    assert.ok(reads.some(read => read.offset === header.length + 5 + seekHead.length + info.length));
});

test('WebM SeekHead cannot redirect parsing outside the Segment boundary', async () => {
    const externalTags = webmTags('PROMPT', 'outside segment');
    const info = ebmlElement('1549a966', Buffer.alloc(0));
    let seekHead = makeWebmSeekHead(0);
    seekHead = makeWebmSeekHead(seekHead.length + info.length);
    const segment = ebmlElement('18538067', Buffer.concat([seekHead, info]));
    const header = ebmlElement('1a45dfa3', ebmlElement('4282', utf8('webm')));
    const bytes = Buffer.concat([header, segment, externalTags]);
    const metadata = await scanWebmVideoMetadata(async (offset, length) => bytes.subarray(offset, offset + length), bytes.length);
    assert.equal(metadata.parserState, 'empty-confirmed');
    assert.equal(metadata.prompt, undefined);
});

test('WebM parses nested SimpleTag names and values', () => {
    const nested = ebmlElement('67c8', Buffer.concat([
        ebmlElement('45a3', utf8('workflow')),
        ebmlElement('4487', utf8('{"nodes":[]}')),
    ]));
    const parent = ebmlElement('67c8', Buffer.concat([
        ebmlElement('45a3', utf8('comfyui')),
        nested,
    ]));
    const bytes = ebmlElement('1254c367', ebmlElement('7373', parent));
    const metadata = parseWebmTagsElement(bytes, { inputComplete: true });
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.workflow, '{"nodes":[]}');
    assert.equal(metadata.generator, 'ComfyUI');
    assert.equal(metadata['WebM Tags'][0].name, 'comfyui/workflow');
});

test('WebM retains multiple Tag entries from one Tags element', () => {
    const tags = webmTagsMany([
        ['PROMPT', 'a ship above the clouds'],
        ['NEGATIVE_PROMPT', 'blurry'],
    ]);
    const bytes = Buffer.concat([
        ebmlElement('1a45dfa3', ebmlElement('4282', utf8('webm'))),
        ebmlElement('18538067', tags),
    ]);
    const metadata = extractVideoMetadata(bytes, { inputComplete: true });
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.prompt, 'a ship above the clouds');
    assert.equal(metadata.negative_prompt, 'blurry');
    assert.equal(metadata['WebM Tags'].length, 2);
});

test('WebM range scanner continues to later Tags elements after an empty one', async () => {
    const emptyTags = ebmlElement('1254c367', Buffer.alloc(0));
    const promptTags = webmTags('PROMPT', 'metadata in the next Tags element');
    let seekHead = makeWebmSeekHead(0);
    seekHead = makeWebmSeekHead(seekHead.length);
    const header = ebmlElement('1a45dfa3', ebmlElement('4282', utf8('webm')));
    const bytes = Buffer.concat([
        header,
        ebmlElement('18538067', Buffer.concat([seekHead, emptyTags, promptTags])),
    ]);
    const metadata = await scanWebmVideoMetadata(async (offset, length) => bytes.subarray(offset, offset + length), bytes.length);
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.prompt, 'metadata in the next Tags element');
});

test('WebM binary TagBinary values are recorded by size instead of decoded as text', () => {
    const binaryTag = ebmlElement('67c8', Buffer.concat([
        ebmlElement('45a3', utf8('BINARY')),
        ebmlElement('4485', Buffer.from('PROMPT\0hidden', 'latin1')),
    ]));
    const tags = ebmlElement('1254c367', ebmlElement('7373', binaryTag));
    const metadata = parseWebmTagsElement(tags, { inputComplete: true });
    assert.equal(metadata.parserState, 'resolved');
    assert.deepEqual(metadata['WebM Tags'], [{ name: 'BINARY', binaryLength: 13 }]);
    assert.equal(metadata['Video Tag: BINARY'], undefined);
});

test('WebM full-buffer parser stops at its element count limit', () => {
    const voidElement = ebmlElement('ec', Buffer.alloc(0));
    const segment = ebmlElement('18538067', Buffer.concat(Array.from({ length: 50001 }, () => voidElement)));
    const bytes = Buffer.concat([
        ebmlElement('1a45dfa3', ebmlElement('4282', utf8('webm'))),
        segment,
    ]);
    const metadata = extractVideoMetadata(bytes, { inputComplete: true });
    assert.equal(metadata.parserState, 'resource-limit');
});

test('full-buffer WebM extraction supports an unknown-size Segment and structured Tags', () => {
    const tags = webmTags('PROMPT', 'entire-file prompt');
    const header = ebmlElement('1a45dfa3', ebmlElement('4282', utf8('webm')));
    const segment = Buffer.concat([
        ebmlId('18538067'),
        Buffer.from([0xff]), // EBML unknown size for Segment
        ebmlElement('1549a966', Buffer.alloc(0)),
        tags,
    ]);
    const metadata = extractVideoMetadata(Buffer.concat([header, segment]), { inputComplete: true });
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.prompt, 'entire-file prompt');
});

test('WebM truncated Segment children remain unresolved instead of confirming empty', () => {
    const truncatedInfo = Buffer.concat([
        ebmlId('1549a966'),
        ebmlSize(16),
        Buffer.from([0x2A, 0x00]),
    ]);
    const header = ebmlElement('1a45dfa3', ebmlElement('4282', utf8('webm')));
    const bytes = Buffer.concat([header, ebmlElement('18538067', truncatedInfo)]);
    const metadata = extractVideoMetadata(bytes, { inputComplete: true });
    assert.equal(metadata.parserState, 'unresolved');
});

test('WebM unknown-size Cluster is unresolved and arbitrary text is not searched', async () => {
    const marker = Buffer.from('PROMPT\0hidden text must not be harvested', 'utf8');
    const unknownCluster = Buffer.concat([ebmlId('1f43b675'), Buffer.from([0xff]), marker]);
    const segment = ebmlElement('18538067', unknownCluster);
    const header = ebmlElement('1a45dfa3', ebmlElement('4282', utf8('webm')));
    const bytes = Buffer.concat([header, segment]);
    const metadata = await scanWebmVideoMetadata(async (offset, length) => bytes.subarray(offset, offset + length), bytes.length);
    assert.equal(metadata.parserState, 'unresolved');
    assert.equal(metadata.prompt, undefined);
});

test('WebM reports a range budget limit instead of treating an incomplete scan as empty', async () => {
    const tags = webmTags('PROMPT', 'test');
    const segment = ebmlElement('18538067', Buffer.concat([
        ebmlElement('1549a966', Buffer.alloc(0)),
        ebmlElement('1f43b675', Buffer.alloc(256, 0)),
        tags,
    ]));
    const header = ebmlElement('1a45dfa3', ebmlElement('4282', utf8('webm')));
    const bytes = Buffer.concat([header, segment]);
    const metadata = await scanWebmVideoMetadata(async (offset, length) => bytes.subarray(offset, offset + length), bytes.length, { maxReads: 1 });
    assert.equal(metadata.parserState, 'resource-limit');
});

test('WebM range scanner honors zero byte and request limits', async () => {
    const bytes = Buffer.concat([
        ebmlElement('1a45dfa3', ebmlElement('4282', utf8('webm'))),
        ebmlElement('18538067', Buffer.alloc(0)),
    ]);
    let reads = 0;
    const readRange = async (offset, length) => {
        reads += 1;
        return bytes.subarray(offset, offset + length);
    };
    assert.equal((await scanWebmVideoMetadata(readRange, bytes.length, { maxBytes: 0 })).parserState, 'resource-limit');
    assert.equal((await scanWebmVideoMetadata(readRange, bytes.length, { maxReads: 0 })).parserState, 'resource-limit');
    assert.equal(reads, 0);
});
