const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { loadParserContext } = require('./phase3_helpers.cjs');

test('XMP parameters support CDATA in namespaced and unprefixed tags', () => {
    const context = loadParserContext();
    assert.equal(
        context.parseXmpMetadata('<x:xmpmeta><x:parameters><![CDATA[raw <tag> & value]]></x:parameters></x:xmpmeta>').parameters,
        'raw <tag> & value',
    );
    assert.equal(
        context.parseXmpMetadata('<parameters><![CDATA[unprefixed <value>]]></parameters>').parameters,
        'unprefixed <value>',
    );
});

test('XMP parameters support single-quoted attributes', () => {
    const context = loadParserContext();
    assert.equal(
        context.parseXmpMetadata(`<rdf:Description parameters='single "quoted" value'></rdf:Description>`).parameters,
        'single "quoted" value',
    );
});

test('XMP decodes hex character references and apostrophes', () => {
    const context = loadParserContext();
    assert.equal(
        context.parseXmpMetadata('<rdf:Description parameters="&#x41;&#x42; &apos;c&apos; &#x1F600;"></rdf:Description>').parameters,
        "AB 'c' 😀",
    );
});

test('XMP namespace declarations are not mistaken for parameters attributes', () => {
    const context = loadParserContext();
    const metadata = context.parseXmpMetadata('<rdf:Description xmlns:parameters="urn:test"><parameters>tag value</parameters></rdf:Description>');
    assert.equal(metadata.parameters, 'tag value');
});

test('XMP parameters support both namespaced tag and unprefixed tag forms', () => {
    const context = loadParserContext();
    assert.equal(
        context.parseXmpMetadata('<rdf:Description><ns:parameters>namespaced</ns:parameters></rdf:Description>').parameters,
        'namespaced',
    );
    assert.equal(
        context.parseXmpMetadata('<rdf:Description><parameters>unprefixed</parameters></rdf:Description>').parameters,
        'unprefixed',
    );
});

test('XMP existing decode order is fixed and new decodes do not introduce double decoding', () => {
    const context = loadParserContext();
    assert.equal(
        context.parseXmpMetadata('<rdf:Description parameters="&amp;#10;"></rdf:Description>').parameters,
        '\n',
    );
    assert.equal(
        context.parseXmpMetadata('<rdf:Description parameters="&amp;#x41;"></rdf:Description>').parameters,
        '&#x41;',
    );
    assert.equal(
        context.parseXmpMetadata('<rdf:Description parameters="&amp;apos;"></rdf:Description>').parameters,
        '&apos;',
    );
});

test('XMP parsing of a 256 KiB input completes well under one second', () => {
    const context = loadParserContext();
    const padding = 'x'.repeat(256 * 1024);
    const xmp = `<x:xmpmeta>${padding}<rdf:Description><parameters>tail value</parameters></rdf:Description></x:xmpmeta>`;
    const started = performance.now();
    const metadata = context.parseXmpMetadata(xmp);
    const elapsed = performance.now() - started;
    assert.equal(metadata.parameters, 'tail value');
    assert.ok(elapsed < 1000, `parse took ${elapsed}ms`);
});
