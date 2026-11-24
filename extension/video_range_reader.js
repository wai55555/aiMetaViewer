/* Bounded response reader shared by the video acquisition path and tests. */
function createVideoReaderAbortError() {
    const error = new Error('Video metadata read aborted.');
    error.name = 'AbortError';
    return error;
}

async function readVideoResponsePrefix(response, maxBytes, signal) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive safe integer');
    if (signal?.aborted) {
        try { await response?.body?.cancel?.(); } catch (_) { }
        throw createVideoReaderAbortError();
    }
    const lengthHeader = response?.headers?.get?.('content-length');
    const declaredLength = typeof lengthHeader === 'string' && /^\d+$/.test(lengthHeader)
        ? Number(lengthHeader)
        : null;
    if (!response?.body) {
        return {
            bytes: new Uint8Array(0),
            complete: declaredLength == null || declaredLength === 0,
            overLimit: declaredLength != null && declaredLength > 0,
        };
    }
    if (typeof response.body.getReader !== 'function') {
        // A non-streaming body cannot be bounded before allocation.
        try { await response.body.cancel?.(); } catch (_) { }
        return { bytes: new Uint8Array(0), complete: false, overLimit: true };
    }

    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    let complete = false;
    let overLimit = false;
    try {
        while (total < maxBytes) {
            if (signal?.aborted) throw createVideoReaderAbortError();
            const record = await reader.read();
            if (record.done) {
                complete = true;
                break;
            }
            const chunk = record.value instanceof Uint8Array ? record.value : new Uint8Array(record.value);
            const remaining = maxBytes - total;
            if (chunk.byteLength > remaining) {
                chunks.push(chunk.subarray(0, remaining));
                total += remaining;
                overLimit = true;
                break;
            }
            chunks.push(chunk);
            total += chunk.byteLength;
        }
        if (!complete && !overLimit && total >= maxBytes) {
            if (signal?.aborted) throw createVideoReaderAbortError();
            const next = await reader.read();
            complete = next.done === true;
            overLimit = !complete;
        }
        if (!complete && overLimit) {
            try { await reader.cancel(); } catch (_) { }
        }
    } catch (error) {
        try { await reader.cancel(error); } catch (_) { }
        throw error;
    } finally {
        try { reader.releaseLock(); } catch (_) { }
    }
    if (complete && declaredLength !== null && declaredLength !== total) {
        // A prematurely closed or inconsistent response must not be treated as a
        // complete resource by callers that use completeness to confirm no metadata.
        complete = false;
        if (declaredLength > maxBytes || total > maxBytes) overLimit = true;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { bytes, complete, overLimit };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { readVideoResponsePrefix };
}
