const test = require('node:test');
const assert = require('node:assert/strict');
const {
    loadParserContext,
    exactArrayBuffer,
    tiffWithTags,
    jpegSegment,
    makeJpeg,
    xmpSegment,
    extendedXmpSegment,
} = require('./phase3_helpers.cjs');

function exifSegment(tiff) {
    return jpegSegment(0xE1, Buffer.concat([
        Buffer.from('Exif\0\0', 'ascii'),
        tiff,
    ]));
}

function extract(context, jpeg) {
    return context.extractMetadata(exactArrayBuffer(jpeg), { format: 'jpeg' });
}

test('JPEG COM adopts A1111 metadata including Japanese text', () => {
    const context = loadParserContext();
    const text = '日本語のプロンプト\nNegative prompt: 低品質\nSteps: 28, Sampler: Euler a, CFG scale: 7, Seed: 42, Size: 1024x1024';
    const jpeg = makeJpeg([jpegSegment(0xFE, Buffer.from(text, 'utf8'))]);
    const result = extract(context, jpeg);
    assert.equal(result.parserState, 'resolved');
    assert.equal(result.parameters, text);
});

test('JPEG COM adopts gated JSON prompt/workflow/parameters', () => {
    const context = loadParserContext();
    for (const body of [
        '{"prompt":"json prompt"}',
        '{ "workflow": {"nodes":[]} }',
        '{"parameters":"a1111"}',
    ]) {
        const result = extract(context, makeJpeg([jpegSegment(0xFE, Buffer.from(body, 'utf8'))]));
        assert.equal(result.parserState, 'resolved', body);
        assert.equal(result.parameters, body);
    }
});

test('JPEG ignores unrelated COM and JSON without a generation key', () => {
    const context = loadParserContext();
    for (const text of [
        'a normal image editor comment',
        'Steps: 12',
        '{"title":"not generation metadata"}',
        '[{"prompt":"array is not accepted"}]',
    ]) {
        const result = extract(context, makeJpeg([jpegSegment(0xFE, Buffer.from(text, 'utf8'))]));
        assert.equal(result.parserState, 'empty-confirmed', text);
        assert.equal(result.parameters, undefined);
    }
});

test('JPEG ignores COM that is not valid UTF-8', () => {
    const context = loadParserContext();
    const invalid = Buffer.from([0x66, 0x6f, 0x6f, 0xff, 0x0a, 0x53, 0x74, 0x65, 0x70, 0x73, 0x3a, 0x20]);
    const result = extract(context, makeJpeg([jpegSegment(0xFE, invalid)]));
    assert.equal(result.parserState, 'empty-confirmed');
    assert.equal(result.parameters, undefined);
});

test('JPEG EXIF parameters win over COM in both segment orders', () => {
    const context = loadParserContext();
    const exif = exifSegment(tiffWithTags({ userComment: 'EXIF parameters' }));
    const com = jpegSegment(0xFE, Buffer.from('COM prompt\nNegative prompt: no\nSteps: 20, Sampler: Euler a', 'utf8'));
    for (const jpeg of [makeJpeg([exif, com]), makeJpeg([com, exif])]) {
        const result = extract(context, jpeg);
        assert.equal(result.parserState, 'resolved');
        assert.equal(result.parameters, 'EXIF parameters');
    }
});

test('JPEG adopts only the first COM that passes the content gate', () => {
    const context = loadParserContext();
    const first = jpegSegment(0xFE, Buffer.from('first\nNegative prompt: x', 'utf8'));
    const second = jpegSegment(0xFE, Buffer.from('second\nNegative prompt: y', 'utf8'));
    const result = extract(context, makeJpeg([first, second]));
    assert.equal(result.parameters, 'first\nNegative prompt: x');
});

test('writeJpegMetadata round-trips the A1111 COM through the content gate', () => {
    const context = loadParserContext();
    const text = 'positive prompt\nNegative prompt: negative\nSteps: 20, Sampler: Euler a, Seed: 1';
    const rewritten = context.writeJpegMetadata(exactArrayBuffer(makeJpeg([])), text);
    const result = extract(context, Buffer.from(rewritten));
    assert.equal(result.parserState, 'resolved');
    assert.equal(result.parameters, text);
});

test('JPEG APP1 XMP parameters are read without confusing EXIF APP1', () => {
    const context = loadParserContext();
    const xmp = '<x:xmpmeta><rdf:RDF><rdf:Description><parameters>XMP prompt</parameters></rdf:Description></rdf:RDF></x:xmpmeta>';
    const xmpResult = extract(context, makeJpeg([xmpSegment(xmp)]));
    assert.equal(xmpResult.parserState, 'resolved');
    assert.equal(xmpResult.parameters, 'XMP prompt');

    const exif = exifSegment(tiffWithTags({ description: 'EXIF description' }));
    const exifResult = extract(context, makeJpeg([exif]));
    assert.equal(exifResult.Description, 'EXIF description');
    assert.equal(exifResult.parameters, undefined);
});

test('JPEG Extended XMP alone stays empty-confirmed', () => {
    const context = loadParserContext();
    const result = extract(context, makeJpeg([extendedXmpSegment()]));
    assert.equal(result.parserState, 'empty-confirmed');
    assert.equal(result.parameters, undefined);
});

test('JPEG truncated XMP follows unresolved/partial rules', () => {
    const context = loadParserContext();
    const full = makeJpeg([xmpSegment('<x:xmpmeta><parameters>truncated prompt</parameters></x:xmpmeta>')]);
    const truncated = full.subarray(0, full.length - 10);
    const noOther = extract(context, truncated);
    assert.equal(noOther.parserState, 'unresolved');

    const exif = exifSegment(tiffWithTags({ description: 'metadata before XMP' }));
    const withExif = makeJpeg([exif, xmpSegment('<x:xmpmeta><parameters>truncated prompt</parameters></x:xmpmeta>')]);
    const partial = extract(context, withExif.subarray(0, withExif.length - 10));
    assert.equal(partial.parserState, 'resolved');
    assert.equal(partial.metadataPartial, true);
    assert.equal(partial.Description, 'metadata before XMP');
});

test('JPEG EXIF values win over XMP in both segment orders', () => {
    const context = loadParserContext();
    const exif = exifSegment(tiffWithTags({ description: 'EXIF description' }));
    const xmp = xmpSegment('<x:xmpmeta><rdf:RDF><rdf:Description><parameters>XMP parameters</parameters><dc:description><rdf:Alt><rdf:li>XMP description</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta>');
    for (const jpeg of [makeJpeg([exif, xmp]), makeJpeg([xmp, exif])]) {
        const result = extract(context, jpeg);
        assert.equal(result.Description, 'EXIF description');
    }
});
