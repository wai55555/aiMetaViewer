const test = require('node:test');
const assert = require('node:assert/strict');
const { loadParserContext, tiffWithTags } = require('./phase3_helpers.cjs');

test('EXIF Software is harvested and does not change existing tags', () => {
    const context = loadParserContext();
    const tiff = tiffWithTags({
        software: 'AI Generator 1.0',
        description: 'description',
        userComment: '{"prompt":"user comment"}',
    });
    const metadata = context.extractExifPayload(tiff);
    assert.equal(metadata.parserState, 'resolved');
    assert.equal(metadata.Software, 'AI Generator 1.0');
    assert.equal(metadata.Description, 'description');
    assert.equal(metadata.parameters, '{"prompt":"user comment"}');
});

test('EXIF Software accepts up to 256 bytes and rejects longer values', () => {
    const context = loadParserContext();
    const accepted = context.extractExifPayload(tiffWithTags({ software: 'x'.repeat(256) }));
    assert.equal(accepted.parserState, 'resolved');
    assert.equal(accepted.Software, 'x'.repeat(256));

    const rejected = context.extractExifPayload(tiffWithTags({ software: 'x'.repeat(257) }));
    assert.equal(rejected.parserState, 'empty-confirmed');
    assert.equal(rejected.Software, undefined);
});

test('EXIF Software supports both TIFF byte orders', () => {
    const context = loadParserContext();
    for (const littleEndian of [true, false]) {
        const metadata = context.extractExifPayload(tiffWithTags({
            software: 'ComfyUI',
            littleEndian,
        }));
        assert.equal(metadata.Software, 'ComfyUI');
    }
});
