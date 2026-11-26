/*
 * FR-PAKO-01 spike: compare pako and DecompressionStream on compressed data
 * used by the PNG scanner paths. This is test-only tooling; it does not change
 * the extension. Run: node tests/phase2/pako_gate.cjs
 */
'use strict';

const zlib = require('node:zlib');
const pako = require('../../extension/pako.js');

async function decompressWithStream(bytes, format) {
    const stream = new DecompressionStream(format);
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const parts = [];
    let total = 0;
    const writing = (async () => {
        await writer.write(bytes);
        await writer.close();
    })();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            parts.push(Buffer.from(value));
            total += value.byteLength;
        }
        await writing;
    } catch (error) {
        try { await writer.abort(); } catch (_) {}
        try { await writing; } catch (_) {}
        error.partialBytes = total;
        throw error;
    }
    return Buffer.concat(parts, total);
}

function pakoInflate(bytes, format) {
    try {
        const output = format === 'gzip' ? pako.ungzip(bytes) : pako.inflate(bytes);
        if (!(output instanceof Uint8Array)) {
            return {
                ok: false,
                error: {
                    name: 'PakoError',
                    message: 'pako returned no output',
                    err: pako.err,
                    msg: pako.msg,
                },
            };
        }
        return { ok: true, bytes: Buffer.from(output) };
    } catch (error) {
        return { ok: false, error: { name: error.name || 'Error', message: error.message || String(error) } };
    }
}

function pakoStreamInflate(bytes) {
    const inflator = new pako.Inflate({ chunkSize: 16 * 1024 });
    const parts = [];
    let total = 0;
    inflator.onData = (chunk) => {
        parts.push(Buffer.from(chunk));
        total += chunk.byteLength;
    };
    inflator.onEnd = function onEnd(status) {
        this.err = status;
        this.msg = this.strm && this.strm.msg ? this.strm.msg : '';
    };
    try {
        const pushed = inflator.push(bytes, true);
        return {
            ok: pushed === true && inflator.err === 0 && inflator.ended === true,
            bytes: Buffer.concat(parts, total),
            error: { err: inflator.err, msg: inflator.msg, ended: inflator.ended === true },
        };
    } catch (error) {
        return {
            ok: false,
            bytes: Buffer.concat(parts, total),
            error: { name: error.name || 'Error', message: error.message || String(error), err: inflator.err, ended: inflator.ended === true },
        };
    }
}

async function streamInflate(bytes, format) {
    try {
        return { ok: true, bytes: await decompressWithStream(bytes, format) };
    } catch (error) {
        return {
            ok: false,
            error: {
                name: error.name,
                message: error.message,
                cause: error.cause?.message,
                partialBytes: error.partialBytes,
            },
        };
    }
}

function makeCases() {
    const rawPngRows = Buffer.alloc(4096 * (4096 + 1), 0);
    const itxtText = Buffer.from('parameters\u0000' + '{"prompt":"phase2 pako gate"}'.repeat(64), 'utf8');
    const stealthPayload = Buffer.from(JSON.stringify({
        prompt: 'phase2 stealth payload',
        steps: 28,
        sampler: 'Euler a',
        seed: 123456789,
    }), 'utf8');
    const idat = zlib.deflateSync(rawPngRows);
    const itxt = zlib.deflateSync(itxtText);
    const stealth = zlib.gzipSync(stealthPayload);
    return [
        { name: 'png-idat', format: 'deflate', compressed: idat, expected: rawPngRows },
        { name: 'itxt-compressed', format: 'deflate', compressed: itxt, expected: itxtText },
        { name: 'stealth-gzip', format: 'gzip', compressed: stealth, expected: stealthPayload },
    ];
}

function makeBrokenCases(valid) {
    const truncated = valid.subarray(0, valid.length - 5);
    const badChecksum = Buffer.from(valid);
    badChecksum[badChecksum.length - 1] ^= 0xff;
    const badHeader = Buffer.from(valid);
    badHeader[0] ^= 0xff;
    return [
        { name: 'truncated', compressed: truncated },
        { name: 'bad-checksum', compressed: badChecksum },
        { name: 'bad-header', compressed: badHeader },
        { name: 'empty', compressed: Buffer.alloc(0) },
        { name: 'trailing-bytes', compressed: Buffer.concat([valid, Buffer.from([1, 2, 3, 4])]) },
    ];
}

async function main() {
    const validResults = [];
    const errorResults = [];
    for (const testCase of makeCases()) {
        const pakoResult = pakoInflate(testCase.compressed, testCase.format);
        const streamResult = await streamInflate(testCase.compressed, testCase.format);
        validResults.push({
            name: testCase.name,
            format: testCase.format,
            inputBytes: testCase.compressed.length,
            expectedBytes: testCase.expected.length,
            pakoOk: pakoResult.ok,
            streamOk: streamResult.ok,
            byteEqual: pakoResult.ok && streamResult.ok && pakoResult.bytes.equals(streamResult.bytes),
            outputEqual: pakoResult.ok && streamResult.ok && pakoResult.bytes.equals(testCase.expected),
        });
        for (const broken of makeBrokenCases(testCase.compressed)) {
            const pakoOneShot = pakoInflate(broken.compressed, testCase.format);
            const pakoStream = pakoStreamInflate(broken.compressed);
            const streamBroken = await streamInflate(broken.compressed, testCase.format);
            errorResults.push({
                base: testCase.name,
                case: broken.name,
                pakoOneShot: pakoOneShot.ok
                    ? { ok: true, bytes: pakoOneShot.bytes.length }
                    : pakoOneShot.error,
                pakoStream: {
                    ok: pakoStream.ok,
                    bytes: pakoStream.bytes.length,
                    error: pakoStream.error,
                },
                stream: streamBroken.ok ? { ok: true, bytes: streamBroken.bytes.length } : streamBroken.error,
            });
        }
    }
    process.stdout.write(`${JSON.stringify({ node: process.version, validResults, errorResults }, null, 2)}\n`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
