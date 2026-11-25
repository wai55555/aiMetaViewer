const test = require('node:test');
const assert = require('node:assert/strict');
const { readVideoResponsePrefix } = require('../../extension/video_range_reader.js');

function streamResponse(stream, contentLength = null, contentEncoding = null) {
    return {
        body: stream,
        headers: {
            get: name => name === 'content-length' ? contentLength :
                name === 'content-encoding' ? contentEncoding : null,
        },
    };
}

test('bounded reader truncates at the byte cap and cancels the remaining response', async () => {
    let cancelled = false;
    const stream = new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])); },
        cancel() { cancelled = true; },
    });
    const result = await readVideoResponsePrefix(streamResponse(stream, '1000'), 6);
    assert.deepEqual(Array.from(result.bytes), [0, 1, 2, 3, 4, 5]);
    assert.equal(result.complete, false);
    assert.equal(result.overLimit, true);
    assert.equal(result.observedBytes, 10);
    assert.equal(cancelled, true);
});

test('bounded reader accepts a complete body whose size equals the cap', async () => {
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            controller.close();
        },
    });
    const result = await readVideoResponsePrefix(streamResponse(stream, '4'), 4);
    assert.deepEqual(Array.from(result.bytes), [1, 2, 3, 4]);
    assert.equal(result.complete, true);
    assert.equal(result.overLimit, false);
});

test('bounded reader rejects a body that ends before its declared content length', async () => {
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
            controller.close();
        },
    });
    const result = await readVideoResponsePrefix(streamResponse(stream, '100'), 6);
    assert.equal(result.complete, false);
    assert.equal(result.overLimit, true);
    assert.equal(result.bytes.length, 6);
});

test('bounded reader detects a small Content-Length mismatch without calling it a resource limit', async () => {
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            controller.close();
        },
    });
    const result = await readVideoResponsePrefix(streamResponse(stream, '10'), 16);
    assert.equal(result.complete, false);
    assert.equal(result.overLimit, false);
    assert.equal(result.observedBytes, 4);
});

test('bounded reader does not compare decoded bytes with a compressed Content-Length', async () => {
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            controller.close();
        },
    });
    const result = await readVideoResponsePrefix(streamResponse(stream, '20', 'gzip'), 16);
    assert.equal(result.complete, true);
    assert.equal(result.overLimit, false);
    assert.equal(result.bytes.length, 4);
});

test('bounded reader charges the extra chunk used to probe for EOF', async () => {
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            controller.enqueue(new Uint8Array([5, 6]));
        },
    });
    const result = await readVideoResponsePrefix(streamResponse(stream), 4);
    assert.equal(result.complete, false);
    assert.equal(result.overLimit, true);
    assert.equal(result.bytes.length, 4);
    assert.equal(result.observedBytes, 6);
});

test('bounded reader cancels and rejects if the request is already aborted', async () => {
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(readVideoResponsePrefix(streamResponse(stream), 4, controller.signal), error => error.name === 'AbortError');
    assert.equal(cancelled, true);
    await assert.rejects(
        readVideoResponsePrefix({ body: null, headers: new Headers() }, 4, controller.signal),
        error => error.name === 'AbortError'
    );
});

test('reader does not allocate an unbounded non-streaming body', async () => {
    let arrayBufferCalled = false;
    let cancelled = false;
    const result = await readVideoResponsePrefix({
        body: { cancel() { cancelled = true; } },
        arrayBuffer: async () => { arrayBufferCalled = true; return new ArrayBuffer(0); },
        headers: { get: () => null },
    }, 10);
    assert.equal(result.overLimit, true);
    assert.equal(arrayBufferCalled, false);
    assert.equal(cancelled, true);
});
