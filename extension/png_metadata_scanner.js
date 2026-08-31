/*
 * PNG固有の逐次メタデータスキャナ。
 * parser.js と pako.js が先に classic script として読み込まれる前提で動作する。
 */
(function installPngMetadataScanner(globalObject) {
    'use strict';

    const PNG_SIGNATURE = new Uint8Array([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    ]);
    const PNG_SIGNATURE_LENGTH = PNG_SIGNATURE.length;
    const CHUNK_LENGTH_BYTES = 4;
    const CHUNK_TYPE_BYTES = 4;
    const CHUNK_CRC_BYTES = 4;
    const IHDR_DATA_LENGTH = 13;
    const IEND_DATA_LENGTH = 0;
    const STEALTH_SIGNATURE_BITS = 'stealth_pnginfo'.length * 8;
    const STEALTH_LENGTH_BITS = 32;
    const STEALTH_HEADER_BITS = STEALTH_SIGNATURE_BITS + STEALTH_LENGTH_BITS;
    const MAX_PNG_DIMENSION = 16384;
    const MAX_ROW_BYTES = 1024 * 1024;
    const MAX_STEALTH_COMPRESSED_BYTES = 8 * 1024 * 1024;
    const MAX_STEALTH_METADATA_BYTES = 8 * 1024 * 1024;
    const MAX_TEXT_CHUNK_BYTES = 8 * 1024 * 1024;
    const MAX_STEALTH_HEADER_ROWS = 160;
    const BITS_PER_BYTE = 8;
    const PNG_FILTER_TYPES = Object.freeze([0, 1, 2, 3, 4]);
    const PNG_CHANNEL_COUNTS = Object.freeze({
        0: 1,
        2: 3,
        3: 1,
        4: 2,
        6: 4,
    });
    const ADAM7_PASS_DEFINITIONS = Object.freeze([
        Object.freeze({ startX: 0, startY: 0, stepX: 8, stepY: 8 }),
        Object.freeze({ startX: 4, startY: 0, stepX: 8, stepY: 8 }),
        Object.freeze({ startX: 0, startY: 4, stepX: 4, stepY: 8 }),
        Object.freeze({ startX: 2, startY: 0, stepX: 4, stepY: 4 }),
        Object.freeze({ startX: 0, startY: 2, stepX: 2, stepY: 4 }),
        Object.freeze({ startX: 1, startY: 0, stepX: 2, stepY: 2 }),
        Object.freeze({ startX: 0, startY: 1, stepX: 1, stepY: 2 }),
    ]);
    const STATUS_NORMAL = 'normal';
    const STATUS_STEALTH = 'stealth';
    const STATUS_NOT_FOUND = 'not-found';
    const STATUS_INVALID = 'invalid-png';
    const STATUS_RESOURCE_LIMIT = 'resource-limit';
    const END_VALID_IEND = 'valid-iend';
    const END_TRUNCATED = 'truncated-input';
    const END_STRUCTURAL = 'structural-invalidity';
    const END_RESOURCE = 'whole-scan-resource-limit';
    const END_INTENTIONAL_STOP = 'intentional-stealth-stop';
    const CHUNK_IHDR = 'IHDR';
    const CHUNK_PLTE = 'PLTE';
    const PLTE_ENTRY_BYTES = 3;
    const MIN_PLTE_ENTRIES = 1;
    const MAX_PLTE_ENTRIES = 256;
    const PNG_PALETTE_MAX_ENTRIES = Object.freeze({
        1: 2,
        2: 4,
        4: 16,
        8: 256,
    });
    const CHUNK_IDAT = 'IDAT';
    const CHUNK_IEND = 'IEND';
    const CHUNK_TEXT = 'tEXt';
    const CHUNK_ITXT = 'iTXt';
    const TEXT_INFLATE_CHUNK_SIZE = 16 * 1024;
    const LAYOUTS = Object.freeze({
        '2:8': Object.freeze({ bytesPerPixel: 3, pixelStride: 3, candidates: ['RGB'], offsets: [0, 1, 2] }),
        '2:16': Object.freeze({ bytesPerPixel: 6, pixelStride: 6, candidates: ['RGB'], offsets: [1, 3, 5] }),
        '4:8': Object.freeze({ bytesPerPixel: 2, pixelStride: 2, candidates: ['Alpha'], offsets: [1] }),
        '4:16': Object.freeze({ bytesPerPixel: 4, pixelStride: 4, candidates: ['Alpha'], offsets: [3] }),
        '6:8': Object.freeze({ bytesPerPixel: 4, pixelStride: 4, candidates: ['RGB', 'Alpha'], offsets: [0, 1, 2, 3] }),
        '6:16': Object.freeze({ bytesPerPixel: 8, pixelStride: 8, candidates: ['RGB', 'Alpha'], offsets: [1, 3, 5, 7] }),
    });
    const STEALTH_SIGNATURES = Object.freeze({
        stealth_pnginfo: Object.freeze({ mode: 'Alpha', compressed: false }),
        stealth_pngcomp: Object.freeze({ mode: 'Alpha', compressed: true }),
        stealth_rgbinfo: Object.freeze({ mode: 'RGB', compressed: false }),
        stealth_rgbcomp: Object.freeze({ mode: 'RGB', compressed: true }),
    });
    const DANGEROUS_KEYWORDS = new Set(['__proto__', 'prototype', 'constructor']);

    class PngScannerDependencyError extends Error {
        constructor(message) {
            super(message);
            this.name = 'PngScannerDependencyError';
        }
    }

    class PngStructuralError extends Error {
        constructor(message, offset) {
            super(message);
            this.name = 'PngStructuralError';
            this.offset = offset;
        }
    }

    class PngResourceLimitError extends Error {
        constructor(limit, observed, offset) {
            super(`PNG resource limit exceeded: ${limit}`);
            this.name = 'PngResourceLimitError';
            this.limit = limit;
            this.observed = observed;
            this.offset = offset;
        }
    }

    class DiagnosticCollector {
        constructor() {
            this.entries = [];
        }

        add(entry) {
            this.entries.push(Object.assign({}, entry));
        }

        snapshot() {
            return this.entries.map((entry) => Object.assign({}, entry));
        }
    }

    function requireDependencies() {
        const crcNames = ['createCrc32State', 'updateCrc32', 'finalizeCrc32'];
        const missingCrc = crcNames.filter((name) => typeof globalObject[name] !== 'function');
        if (missingCrc.length > 0) {
            throw new PngScannerDependencyError(`PNG scanner requires parser.js incremental CRC API: ${missingCrc.join(', ')}`);
        }
    }

    function hasPako() {
        return globalObject.pako && typeof globalObject.pako.Inflate === 'function';
    }

    function toUint8Array(value) {
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        throw new TypeError('PNG scanner input must be an ArrayBuffer or Uint8Array.');
    }

    function readUint32(view, offset) {
        return (((view[offset] * 0x1000000) + (view[offset + 1] << 16) +
            (view[offset + 2] << 8) + view[offset + 3]) >>> 0);
    }

    function bytesEqual(left, right) {
        if (left.length !== right.length) return false;
        for (let index = 0; index < left.length; index += 1) {
            if (left[index] !== right[index]) return false;
        }
        return true;
    }

    function ascii(bytes) {
        let result = '';
        for (let index = 0; index < bytes.length; index += 1) result += String.fromCharCode(bytes[index]);
        return result;
    }

    function isChunkTypeByte(byte) {
        return (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A);
    }

    function isCriticalType(typeBytes) {
        return (typeBytes[0] & 0x20) === 0;
    }

    function isSafeKeyword(keyword) {
        return !DANGEROUS_KEYWORDS.has(keyword);
    }

    function decodeLatin1(bytes) {
        let result = '';
        for (let index = 0; index < bytes.length; index += 1) result += String.fromCharCode(bytes[index]);
        return result;
    }

    function decodeUtf8Strict(bytes) {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }

    function findZero(bytes, start) {
        for (let index = start; index < bytes.length; index += 1) {
            if (bytes[index] === 0) return index;
        }
        return -1;
    }

    function getSafeTextKeyword(data) {
        const separator = findZero(data, 0);
        if (separator <= 0 || separator > 79) return null;
        for (let index = 0; index < separator; index += 1) {
            const byte = data[index];
            if (byte < 0x20 || (byte > 0x7E && byte < 0xA1)) return null;
        }
        const keyword = decodeLatin1(data.slice(0, separator));
        return isSafeKeyword(keyword) ? keyword : null;
    }

    function addTextDiagnostic(collector, type, offset, detail, keyword, limit, observed) {
        const entry = { category: 'text-chunk-local-discard', chunkType: type, offset, detail };
        if (keyword && isSafeKeyword(keyword)) entry.keyword = keyword;
        if (limit) entry.limit = limit;
        if (observed !== undefined) entry.observed = observed;
        collector.add(entry);
    }

    function addUnsupportedDiagnostic(collector, detail, observed) {
        collector.add({ category: 'unsupported-stealth', detail, observed });
    }

    function isValidIhdrCombination(bitDepth, colorType, interlace) {
        const allowedBitDepths = {
            0: [1, 2, 4, 8, 16],
            2: [8, 16],
            3: [1, 2, 4, 8],
            4: [8, 16],
            6: [8, 16],
        };
        return (interlace === 0 || interlace === 1) &&
            Object.prototype.hasOwnProperty.call(allowedBitDepths, colorType) &&
            allowedBitDepths[colorType].includes(bitDepth);
    }

    function makeLayout(width, height, bitDepth, colorType, interlace, collector, offset) {
        if (width === 0 || height === 0 || width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION) {
            throw new PngResourceLimitError('MAX_PNG_DIMENSION', Math.max(width, height), offset);
        }
        const layout = LAYOUTS[`${colorType}:${bitDepth}`];
        if (interlace !== 0 || !layout) {
            addUnsupportedDiagnostic(collector, 'unsupported PNG stealth layout', { bitDepth, colorType, interlace });
            return null;
        }
        const rowBytes = width * layout.bytesPerPixel;
        if (!Number.isSafeInteger(rowBytes) || rowBytes > MAX_ROW_BYTES) {
            throw new PngResourceLimitError('MAX_ROW_BYTES', rowBytes, offset);
        }
        return Object.assign({ width, height, bitDepth, colorType, interlace, rowBytes }, layout);
    }

    function getPassExtent(size, start, step) {
        if (size <= start) return 0;
        return Math.floor((size - 1 - start) / step) + 1;
    }

    function calculateStructureRowBytes(width, channels, bitDepth, offset) {
        const rowBits = width * channels * bitDepth;
        const rowBytes = Math.ceil(rowBits / BITS_PER_BYTE);
        if (!Number.isSafeInteger(rowBytes) || rowBytes > MAX_ROW_BYTES) {
            throw new PngResourceLimitError('MAX_ROW_BYTES', rowBytes, offset);
        }
        return rowBytes;
    }

    function makeStructureLayout(width, height, bitDepth, colorType, interlace, offset) {
        const channels = PNG_CHANNEL_COUNTS[colorType];
        const passes = [];
        const definitions = interlace === 0
            ? [{ startX: 0, startY: 0, stepX: 1, stepY: 1 }]
            : ADAM7_PASS_DEFINITIONS;
        for (const definition of definitions) {
            const passWidth = getPassExtent(width, definition.startX, definition.stepX);
            const passHeight = getPassExtent(height, definition.startY, definition.stepY);
            if (passWidth === 0 || passHeight === 0) continue;
            passes.push({
                width: passWidth,
                height: passHeight,
                rowBytes: calculateStructureRowBytes(passWidth, channels, bitDepth, offset),
            });
        }
        const expectedDecodedBytes = passes.reduce(
            (total, pass) => total + pass.height * (pass.rowBytes + 1),
            0,
        );
        if (!Number.isSafeInteger(expectedDecodedBytes)) {
            throw new PngResourceLimitError('MAX_DECODED_BYTES', expectedDecodedBytes, offset);
        }
        return {
            width,
            height,
            bitDepth,
            colorType,
            interlace,
            channels,
            passes,
            expectedDecodedBytes,
        };
    }

    function paeth(left, above, upperLeft) {
        const predictor = left + above - upperLeft;
        const leftDistance = Math.abs(predictor - left);
        const aboveDistance = Math.abs(predictor - above);
        const upperLeftDistance = Math.abs(predictor - upperLeft);
        if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
        if (aboveDistance <= upperLeftDistance) return above;
        return upperLeft;
    }

    function unpackSignature(bytes) {
        return ascii(bytes);
    }

    function makeCandidate(mode, width, height, totalBits) {
        const channelCount = mode === 'RGB' ? 3 : 1;
        const pendingRows = Math.min(height, MAX_STEALTH_HEADER_ROWS);
        const pendingBitCount = width * pendingRows * channelCount;
        return {
            mode,
            state: 'UNDECIDED',
            signature: null,
            compressed: false,
            bitLength: null,
            payload: null,
            observedPayload: null,
            observedCount: 0,
            totalBits,
            header: new Uint8Array(Math.ceil(STEALTH_HEADER_BITS / 8)),
            observedHeader: new Uint8Array(Math.ceil(STEALTH_HEADER_BITS / 8)),
            observedHeaderCount: 0,
            pendingBits: new Uint8Array(Math.ceil(pendingBitCount / 8)),
            pendingSeen: new Uint8Array(Math.ceil(pendingBitCount / 8)),
            pendingRows,
            channelCount,
            result: null,
            released: false,
            width,
            height,
        };
    }

    function candidateReject(candidate, detail) {
        candidate.state = 'REJECTED';
        candidate.rejectionDetail = detail;
        candidate.payload = null;
        candidate.observedPayload = null;
        candidate.pendingBits = null;
        candidate.pendingSeen = null;
    }

    function setPackedBit(bytes, bitIndex, value) {
        if (value) bytes[bitIndex >>> 3] |= (1 << (7 - (bitIndex & 7)));
    }

    function getPackedUint32(bytes, offset) {
        return (((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) +
            (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0);
    }

    function getPackedBit(bytes, bitIndex) {
        return (bytes[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1;
    }

    function getPendingBitIndex(candidate, bitIndex) {
        let x;
        let y;
        let channel = 0;
        if (candidate.mode === 'Alpha') {
            x = Math.floor(bitIndex / candidate.height);
            y = bitIndex % candidate.height;
        } else {
            const pixelIndex = Math.floor(bitIndex / 3);
            channel = bitIndex % 3;
            x = Math.floor(pixelIndex / candidate.height);
            y = pixelIndex % candidate.height;
        }
        if (y >= candidate.pendingRows || x >= candidate.width) return -1;
        return (y * candidate.width + x) * candidate.channelCount + channel;
    }

    function rememberPendingBit(candidate, bitIndex, value) {
        const pendingIndex = getPendingBitIndex(candidate, bitIndex);
        if (pendingIndex < 0) return;
        setPackedBit(candidate.pendingSeen, pendingIndex, true);
        if (value) setPackedBit(candidate.pendingBits, pendingIndex, true);
    }

    function consumePayloadBit(candidate, payloadBit, value, collector, offset) {
        if (payloadBit < 0 || payloadBit >= candidate.bitLength) return;
        const observedByte = payloadBit >>> 3;
        const observedMask = 1 << (7 - (payloadBit & 7));
        if ((candidate.observedPayload[observedByte] & observedMask) !== 0) return;
        candidate.observedPayload[observedByte] |= observedMask;
        setPackedBit(candidate.payload, payloadBit, value);
        candidate.observedCount += 1;
        if (candidate.observedCount === candidate.bitLength) {
            candidate.state = 'COMPLETE';
            candidate.result = decodeStealthCandidate(candidate, collector, offset);
            candidate.observedPayload = null;
            candidate.payload = null;
            if (!candidate.result) candidateReject(candidate, 'stealth payload decoding failed');
        }
    }

    function replayPendingPayload(candidate, collector, offset) {
        if (!candidate.pendingSeen || candidate.bitLength === 0) return;
        for (let y = 0; y < candidate.pendingRows; y += 1) {
            for (let x = 0; x < candidate.width; x += 1) {
                for (let channel = 0; channel < candidate.channelCount; channel += 1) {
                    const pendingIndex = (y * candidate.width + x) * candidate.channelCount + channel;
                    if (!getPackedBit(candidate.pendingSeen, pendingIndex)) continue;
                    const pixelIndex = x * candidate.height + y;
                    const bitIndex = candidate.mode === 'Alpha'
                        ? pixelIndex
                        : pixelIndex * 3 + channel;
                    const payloadBit = bitIndex - STEALTH_HEADER_BITS;
                    if (payloadBit >= 0 && payloadBit < candidate.bitLength) {
                        consumePayloadBit(
                            candidate,
                            payloadBit,
                            getPackedBit(candidate.pendingBits, pendingIndex),
                            collector,
                            offset,
                        );
                    }
                    if (candidate.state === 'COMPLETE' || candidate.state === 'REJECTED') {
                        candidate.pendingBits = null;
                        candidate.pendingSeen = null;
                        return;
                    }
                }
            }
        }
        candidate.pendingBits = null;
        candidate.pendingSeen = null;
    }

    function setCandidateBit(candidate, bitIndex, value, collector, offset) {
        if (candidate.state === 'REJECTED' || candidate.state === 'COMPLETE' || candidate.released) return;
        if (bitIndex >= candidate.totalBits) {
            candidateReject(candidate, 'stealth coordinate range exhausted');
            return;
        }
        if (bitIndex < STEALTH_HEADER_BITS) {
            const observedByte = bitIndex >>> 3;
            const observedMask = 1 << (7 - (bitIndex & 7));
            if ((candidate.observedHeader[observedByte] & observedMask) !== 0) return;
            candidate.observedHeader[observedByte] |= observedMask;
            candidate.observedHeaderCount += 1;
            setPackedBit(candidate.header, bitIndex, value);
            if (candidate.observedHeaderCount !== STEALTH_HEADER_BITS) return;
            const signature = unpackSignature(candidate.header.slice(0, STEALTH_SIGNATURE_BITS / 8));
            const signatureInfo = STEALTH_SIGNATURES[signature];
            if (!signatureInfo || signatureInfo.mode !== candidate.mode) {
                candidateReject(candidate, 'stealth signature mismatch');
                return;
            }
            candidate.signature = signature;
            candidate.compressed = signatureInfo.compressed;
            candidate.state = 'MATCHED';
            candidate.state = 'READING_LENGTH';
            candidate.bitLength = getPackedUint32(candidate.header, STEALTH_SIGNATURE_BITS / 8);
            const byteLimit = candidate.compressed ? MAX_STEALTH_COMPRESSED_BYTES : MAX_STEALTH_METADATA_BYTES;
            if ((candidate.bitLength & 7) !== 0) {
                candidateReject(candidate, 'stealth bit length is not byte aligned');
            } else if (candidate.bitLength > byteLimit * 8) {
                throw new PngResourceLimitError(candidate.compressed ? 'MAX_STEALTH_COMPRESSED_BYTES' : 'MAX_STEALTH_METADATA_BYTES', candidate.bitLength / 8, offset);
            } else if (STEALTH_HEADER_BITS + candidate.bitLength > candidate.totalBits) {
                candidateReject(candidate, 'stealth payload exceeds image coordinates');
            } else {
                candidate.payload = new Uint8Array(candidate.bitLength / 8);
                candidate.observedPayload = new Uint8Array(Math.ceil(candidate.bitLength / 8));
                candidate.observedCount = 0;
                if (candidate.bitLength === 0) {
                    candidate.state = 'COMPLETE';
                    candidate.result = decodeStealthCandidate(candidate, collector, offset);
                    candidate.observedPayload = null;
                    candidate.payload = null;
                    if (!candidate.result) candidateReject(candidate, 'empty stealth payload decoding failed');
                } else {
                    candidate.state = 'READING_PAYLOAD';
                    replayPendingPayload(candidate, collector, offset);
                }
            }
            return;
        }
        if (candidate.state !== 'READING_PAYLOAD') {
            rememberPendingBit(candidate, bitIndex, value);
            return;
        }
        const payloadBit = bitIndex - STEALTH_HEADER_BITS;
        if (payloadBit >= candidate.bitLength) return;
        consumePayloadBit(candidate, payloadBit, value, collector, offset);
    }

    const STEALTH_INFLATE_CHUNK_SIZE = 16 * 1024;

    function inflateStealthPayload(bytes, offset) {
        if (!hasPako()) throw new PngScannerDependencyError('PNG scanner requires pako.Inflate for gzip Stealth payload.');
        let outputSize = 0;
        let overflow = false;
        const outputParts = [];
        const inflator = new globalObject.pako.Inflate({ chunkSize: STEALTH_INFLATE_CHUNK_SIZE });
        inflator.onData = (chunk) => {
            const part = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            outputSize += part.length;
            if (outputSize > MAX_STEALTH_METADATA_BYTES) {
                overflow = true;
                return;
            }
            outputParts.push(part.slice());
        };
        inflator.onEnd = function onStealthInflateEnd(status) {
            this.err = status;
            this.msg = this.strm && this.strm.msg ? this.strm.msg : '';
        };
        const pushed = inflator.push(bytes, true);
        if (overflow) {
            throw new PngResourceLimitError('MAX_STEALTH_METADATA_BYTES', outputSize, offset);
        }
        if (!pushed || inflator.err !== 0 || !inflator.ended) return null;
        const output = new Uint8Array(outputSize);
        let cursor = 0;
        for (const part of outputParts) {
            output.set(part, cursor);
            cursor += part.length;
        }
        return output;
    }

    function decodeStealthCandidate(candidate, collector, offset) {
        try {
            let bytes = candidate.payload;
            if (candidate.compressed) {
                bytes = inflateStealthPayload(bytes, offset);
                candidate.payload = null;
                if (!(bytes instanceof Uint8Array)) throw new Error('gzip decoding failed');
            }
            const value = decodeUtf8Strict(bytes);
            return { key: `Stealth PNG Info (${candidate.mode})`, value };
        } catch (error) {
            if (error instanceof PngScannerDependencyError || error instanceof PngResourceLimitError) throw error;
            collector.add({ category: 'stealth-candidate-rejected', candidate: candidate.mode, offset, detail: 'strict UTF-8 or gzip decoding failed' });
            return null;
        }
    }

    function allCandidatesRejected(candidates) {
        return candidates.length > 0 && candidates.every((candidate) => candidate.state === 'REJECTED');
    }

    function releaseCandidates(candidates, offset, keepCandidate = null) {
        for (const candidate of candidates) {
            if (candidate !== keepCandidate && !candidate.released) {
                candidate.released = true;
                candidate.payload = null;
                candidate.observedPayload = null;
                candidate.header = new Uint8Array(0);
                candidate.releaseDiagnosticPending = true;
                candidate.releaseDiagnosticOffset = offset;
            }
            candidate.pendingBits = null;
            candidate.pendingSeen = null;
        }
    }

    function flushCandidateReleaseDiagnostics(candidates, collector, keepResult) {
        for (const candidate of candidates) {
            if (!candidate.releaseDiagnosticPending ||
                (keepResult && candidate.result === keepResult) ||
                candidate.releaseDiagnosticEmitted) continue;
            candidate.releaseDiagnosticEmitted = true;
            collector.add({
                category: 'candidate-release',
                candidate: candidate.mode,
                offset: candidate.releaseDiagnosticOffset,
            });
        }
    }

    class RowAssembler {
        constructor(layout, candidates, collector) {
            this.layout = layout;
            this.candidates = candidates;
            this.collector = collector;
            this.previous = new Uint8Array(layout.rowBytes);
            this.scanline = new Uint8Array(layout.rowBytes + 1);
            this.current = new Uint8Array(layout.rowBytes);
            this.scanlineOffset = 0;
            this.rowsCompleted = 0;
            this.decodedBytes = 0;
        }

        consume(output, absoluteOffset) {
            for (let index = 0; index < output.length; index += 1) {
                if (this.rowsCompleted >= this.layout.height) {
                    throw new PngStructuralError(
                        'PNG IDAT has excess decoded scanlines.',
                        absoluteOffset,
                    );
                }
                this.scanline[this.scanlineOffset] = output[index];
                this.scanlineOffset += 1;
                this.decodedBytes += 1;
                if (this.decodedBytes > this.layout.height * (this.layout.rowBytes + 1)) {
                    throw new PngStructuralError(
                        'PNG IDAT decoded byte count exceeds IHDR expectation.',
                        absoluteOffset,
                    );
                }
                if (this.scanlineOffset === this.scanline.length) {
                    this.finishRow(absoluteOffset);
                    this.scanlineOffset = 0;
                }
            }
        }

        finishRow(absoluteOffset) {
            const filterType = this.scanline[0];
            if (!PNG_FILTER_TYPES.includes(filterType)) throw new PngStructuralError(`Unsupported PNG filter type: ${filterType}`);
            const bpp = this.layout.bytesPerPixel;
            for (let index = 0; index < this.layout.rowBytes; index += 1) {
                const raw = this.scanline[index + 1];
                const left = index >= bpp ? this.current[index - bpp] : 0;
                const above = this.previous[index];
                const upperLeft = index >= bpp ? this.previous[index - bpp] : 0;
                let value = raw;
                if (filterType === 1) value = (raw + left) & 0xFF;
                else if (filterType === 2) value = (raw + above) & 0xFF;
                else if (filterType === 3) value = (raw + Math.floor((left + above) / 2)) & 0xFF;
                else if (filterType === 4) value = (raw + paeth(left, above, upperLeft)) & 0xFF;
                this.current[index] = value;
            }
            this.processRow(absoluteOffset);
            const oldPrevious = this.previous;
            this.previous = this.current;
            this.current = oldPrevious;
            this.current.fill(0);
            this.rowsCompleted += 1;
        }

        processRow(absoluteOffset) {
            const { width, height, pixelStride, offsets } = this.layout;
            const rgbCandidate = this.candidates.find((candidate) => candidate.mode === 'RGB' && !candidate.released);
            const alphaCandidate = this.candidates.find((candidate) => candidate.mode === 'Alpha' && !candidate.released);
            for (let x = 0; x < width; x += 1) {
                const y = this.rowsCompleted;
                const pixelOffset = x * pixelStride;
                if (rgbCandidate && rgbCandidate.state !== 'REJECTED') {
                    for (let channel = 0; channel < 3; channel += 1) {
                        const pixelIndex = x * height + y;
                        setCandidateBit(rgbCandidate, pixelIndex * 3 + channel, this.current[pixelOffset + offsets[channel]] & 1, this.collector, absoluteOffset);
                    }
                }
                if (alphaCandidate && alphaCandidate.state !== 'REJECTED') {
                    const alphaOffset = offsets[offsets.length - 1];
                    setCandidateBit(alphaCandidate, x * height + y, this.current[pixelOffset + alphaOffset] & 1, this.collector, absoluteOffset);
                }
            }
        }
    }

    class DecodedRowValidator {
        constructor(layout) {
            this.layout = layout;
            this.passIndex = 0;
            this.currentRowBytes = 0;
            this.rowsRemaining = 0;
            this.rowOffset = 0;
            this.rowsCompleted = 0;
            this.decodedBytes = 0;
            this.advancePass();
        }

        advancePass() {
            if (this.passIndex >= this.layout.passes.length) return;
            const pass = this.layout.passes[this.passIndex];
            this.currentRowBytes = pass.rowBytes;
            this.rowsRemaining = pass.height;
        }

        consume(output, absoluteOffset) {
            for (let index = 0; index < output.length; index += 1) {
                if (this.passIndex >= this.layout.passes.length ||
                    this.decodedBytes >= this.layout.expectedDecodedBytes) {
                    throw new PngStructuralError('PNG IDAT has excess decoded bytes.', absoluteOffset);
                }
                if (this.rowOffset === 0 && !PNG_FILTER_TYPES.includes(output[index])) {
                    throw new PngStructuralError(
                        `Unsupported PNG filter type: ${output[index]}`,
                        absoluteOffset,
                    );
                }
                this.rowOffset += 1;
                this.decodedBytes += 1;
                if (this.rowOffset !== this.currentRowBytes + 1) continue;
                this.rowOffset = 0;
                this.rowsCompleted += 1;
                this.rowsRemaining -= 1;
                if (this.rowsRemaining === 0) {
                    this.passIndex += 1;
                    this.advancePass();
                }
            }
        }

        assertComplete() {
            if (this.passIndex !== this.layout.passes.length || this.rowOffset !== 0 ||
                this.decodedBytes !== this.layout.expectedDecodedBytes) {
                throw new PngStructuralError('PNG IDAT decoded size does not match IHDR.');
            }
        }
    }

    function parseTextChunk(type, data, offset, collector, metadata) {
        if (data.length > MAX_TEXT_CHUNK_BYTES) {
            addTextDiagnostic(collector, type, offset, 'text chunk input exceeds limit', null, 'MAX_TEXT_CHUNK_BYTES', data.length);
            return;
        }
        if (type === CHUNK_TEXT) parseTtext(data, offset, collector, metadata);
        else parseItxt(data, offset, collector, metadata);
    }

    function parseTtext(data, offset, collector, metadata) {
        const separator = findZero(data, 0);
        if (separator <= 0 || separator > 79) {
            addTextDiagnostic(collector, CHUNK_TEXT, offset, 'invalid tEXt keyword grammar');
            return;
        }
        const keywordBytes = data.slice(0, separator);
        for (const byte of keywordBytes) {
            if (byte < 0x20 || (byte > 0x7E && byte < 0xA1)) {
                addTextDiagnostic(collector, CHUNK_TEXT, offset, 'invalid Latin-1 keyword');
                return;
            }
        }
        const keyword = decodeLatin1(keywordBytes);
        if (!isSafeKeyword(keyword)) {
            addTextDiagnostic(collector, CHUNK_TEXT, offset, 'dangerous keyword rejected');
            return;
        }
        const text = decodeLatin1(data.slice(separator + 1));
        metadata[keyword] = text;
    }

    function parseItxt(data, offset, collector, metadata) {
        const keywordEnd = findZero(data, 0);
        if (keywordEnd <= 0 || keywordEnd > 79) {
            addTextDiagnostic(collector, CHUNK_ITXT, offset, 'invalid iTXt keyword grammar');
            return;
        }
        const keywordBytes = data.slice(0, keywordEnd);
        for (const byte of keywordBytes) {
            if (byte < 0x20 || (byte > 0x7E && byte < 0xA1)) {
                addTextDiagnostic(collector, CHUNK_ITXT, offset, 'invalid Latin-1 keyword');
                return;
            }
        }
        const keyword = decodeLatin1(keywordBytes);
        let cursor = keywordEnd + 1;
        if (cursor + 2 > data.length) {
            addTextDiagnostic(collector, CHUNK_ITXT, offset, 'iTXt flag or method is missing', keyword);
            return;
        }
        const compressionFlag = data[cursor];
        const compressionMethod = data[cursor + 1];
        cursor += 2;
        if (compressionFlag !== 0 && compressionFlag !== 1) {
            addTextDiagnostic(collector, CHUNK_ITXT, offset, 'unsupported iTXt compression flag', keyword, null, compressionFlag);
            return;
        }
        if (compressionMethod !== 0) {
            addTextDiagnostic(collector, CHUNK_ITXT, offset, 'unsupported iTXt compression method', keyword, null, compressionMethod);
            return;
        }
        const languageEnd = findZero(data, cursor);
        if (languageEnd < 0) {
            addTextDiagnostic(collector, CHUNK_ITXT, offset, 'iTXt language separator is missing', keyword);
            return;
        }
        try {
            const language = decodeUtf8Strict(data.slice(cursor, languageEnd));
            if (!/^[A-Za-z0-9-]*$/.test(language)) {
                addTextDiagnostic(collector, CHUNK_ITXT, offset, 'iTXt language syntax is invalid', keyword);
                return;
            }
        } catch (error) {
            addTextDiagnostic(collector, CHUNK_ITXT, offset, 'iTXt language is not strict UTF-8', keyword);
            return;
        }
        cursor = languageEnd + 1;
        const translatedEnd = findZero(data, cursor);
        if (translatedEnd < 0) {
            addTextDiagnostic(collector, CHUNK_ITXT, offset, 'iTXt translated-keyword separator is missing', keyword);
            return;
        }
        try {
            decodeUtf8Strict(data.slice(cursor, translatedEnd));
        } catch (error) {
            addTextDiagnostic(collector, CHUNK_ITXT, offset, 'iTXt translated keyword is not strict UTF-8', keyword);
            return;
        }
        cursor = translatedEnd + 1;
        if (!isSafeKeyword(keyword)) {
            addTextDiagnostic(collector, CHUNK_ITXT, offset, 'dangerous keyword rejected');
            return;
        }
        const textBytes = data.slice(cursor);
        const text = compressionFlag === 0
            ? decodeUncompressedItxt(textBytes, offset, keyword, collector)
            : inflateItxt(textBytes, offset, keyword, collector);
        if (text !== null) metadata[keyword] = text;
    }

    function decodeUncompressedItxt(bytes, offset, keyword, collector) {
        try {
            return decodeUtf8Strict(bytes);
        } catch (error) {
            addTextDiagnostic(collector, CHUNK_ITXT, offset, 'iTXt text is not strict UTF-8', keyword);
            return null;
        }
    }

    function inflateItxt(bytes, offset, keyword, collector) {
        if (!hasPako()) throw new PngScannerDependencyError('PNG scanner requires pako.Inflate for compressed iTXt.');
        let outputSize = 0;
        let overflow = false;
        const outputParts = [];
        const inflator = new globalObject.pako.Inflate({ chunkSize: TEXT_INFLATE_CHUNK_SIZE });
        inflator.onData = (chunk) => {
            const part = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            outputSize += part.length;
            if (outputSize > MAX_TEXT_CHUNK_BYTES) {
                overflow = true;
                return;
            }
            outputParts.push(part.slice());
        };
        inflator.onEnd = function onTextInflateEnd(status) {
            this.err = status;
            this.msg = this.strm && this.strm.msg ? this.strm.msg : '';
        };
        const pushed = inflator.push(bytes, true);
        if (!pushed || inflator.err !== 0 || !inflator.ended || overflow) {
            addTextDiagnostic(
                collector,
                CHUNK_ITXT,
                offset,
                overflow ? 'compressed iTXt output exceeds limit' : 'compressed iTXt stream is invalid',
                keyword,
                overflow ? 'MAX_TEXT_CHUNK_BYTES' : null,
                outputSize,
            );
            return null;
        }
        const output = new Uint8Array(outputSize);
        let cursor = 0;
        for (const part of outputParts) {
            output.set(part, cursor);
            cursor += part.length;
        }
        try {
            return decodeUtf8Strict(output);
        } catch (error) {
            addTextDiagnostic(collector, CHUNK_ITXT, offset, 'compressed iTXt text is not strict UTF-8', keyword);
            return null;
        }
    }

    function createInflate(rowAssembler, offsetProvider) {
        if (!hasPako()) throw new PngScannerDependencyError('PNG scanner requires pako.Inflate for IDAT.');
        const inflator = new globalObject.pako.Inflate();
        inflator.onData = (chunk) => {
            if (!rowAssembler) return;
            const output = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
            rowAssembler.consume(output, offsetProvider());
        };
        inflator.onEnd = function onIdatEnd(status) {
            this.err = status;
            this.msg = this.strm && this.strm.msg ? this.strm.msg : '';
        };
        return inflator;
    }

    class PngChunkScanner {
        constructor(options) {
            this.options = options || {};
            this.collector = new DiagnosticCollector();
            this.metadata = Object.create(null);
            this.state = 'SIGNATURE';
            this.signature = new Uint8Array(PNG_SIGNATURE_LENGTH);
            this.signatureOffset = 0;
            this.field = null;
            this.fieldOffset = 0;
            this.offset = 0;
            this.currentChunkOffset = 0;
            this.currentLength = 0;
            this.currentTypeBytes = null;
            this.currentType = null;
            this.currentData = null;
            this.currentDataOffset = 0;
            this.currentCrcState = null;
            this.ihdr = null;
            this.plteSeen = false;
            this.plteEntryCount = null;
            this.layout = null;
            this.structureLayout = null;
            this.rowAssembler = null;
            this.idatStructureValidator = null;
            this.idatInflate = null;
            this.idatChunkOffset = null;
            this.idatSeen = false;
            this.idatEnded = false;
            this.idatOpen = false;
            this.iendSeen = false;
            this.stealthStopped = false;
            this.validateIdatAfterStealth = false;
            this.analysisEndReason = null;
            this.candidates = [];
            this.stealthResult = null;
            this.fatalError = null;
        }

        checkAbort() {
            if (this.options.signal && this.options.signal.aborted) throw createAbortError('PNG scan aborted.');
        }

        feed(input) {
            this.checkAbort();
            const bytes = toUint8Array(input);
            let cursor = 0;
            while (cursor < bytes.length && this.state !== 'DONE') {
                this.checkAbort();
                if (this.state === 'SIGNATURE') cursor += this.consumeSignature(bytes, cursor);
                else if (this.state === 'CHUNK_LENGTH') cursor += this.consumeFixed(bytes, cursor, CHUNK_LENGTH_BYTES, 'CHUNK_TYPE');
                else if (this.state === 'CHUNK_TYPE') cursor += this.consumeType(bytes, cursor);
                else if (this.state === 'CHUNK_DATA') cursor += this.consumeData(bytes, cursor);
                else if (this.state === 'CHUNK_CRC') cursor += this.consumeFixed(bytes, cursor, CHUNK_CRC_BYTES, 'CHUNK_COMPLETE');
                else throw new PngStructuralError(`Unknown PNG parser state: ${this.state}`);
            }
        }

        consumeSignature(bytes, cursor) {
            const amount = Math.min(bytes.length - cursor, PNG_SIGNATURE_LENGTH - this.signatureOffset);
            this.signature.set(bytes.subarray(cursor, cursor + amount), this.signatureOffset);
            this.signatureOffset += amount;
            this.offset += amount;
            if (this.signatureOffset === PNG_SIGNATURE_LENGTH) {
                if (!bytesEqual(this.signature, PNG_SIGNATURE)) throw new PngStructuralError('Invalid PNG signature.');
                this.state = 'CHUNK_LENGTH';
            }
            return amount;
        }

        consumeFixed(bytes, cursor, length, nextState) {
            if (!this.field) {
                this.field = new Uint8Array(length);
                this.fieldOffset = 0;
            }
            const amount = Math.min(bytes.length - cursor, length - this.fieldOffset);
            this.field.set(bytes.subarray(cursor, cursor + amount), this.fieldOffset);
            this.fieldOffset += amount;
            this.offset += amount;
            if (this.fieldOffset === length) {
                const completed = this.field;
                this.field = null;
                this.fieldOffset = 0;
                if (nextState === 'CHUNK_TYPE') this.beginChunk(completed);
                else if (nextState === 'CHUNK_COMPLETE') this.completeChunk(completed);
                else this.state = nextState;
            }
            return amount;
        }

        beginChunk(lengthBytes) {
            this.currentChunkOffset = this.offset - CHUNK_LENGTH_BYTES;
            this.currentLength = readUint32(lengthBytes, 0);
            this.currentData = null;
            this.currentDataOffset = 0;
            this.state = 'CHUNK_TYPE';
            this.field = new Uint8Array(CHUNK_TYPE_BYTES);
            this.fieldOffset = 0;
        }

        consumeType(bytes, cursor) {
            const amount = Math.min(bytes.length - cursor, CHUNK_TYPE_BYTES - this.fieldOffset);
            this.field.set(bytes.subarray(cursor, cursor + amount), this.fieldOffset);
            this.fieldOffset += amount;
            this.offset += amount;
            if (this.fieldOffset !== CHUNK_TYPE_BYTES) return amount;
            this.currentTypeBytes = this.field;
            this.currentType = ascii(this.currentTypeBytes);
            this.field = null;
            this.fieldOffset = 0;
            this.prepareChunk();
            this.state = 'CHUNK_DATA';
            if (this.currentLength === 0) {
                this.state = 'CHUNK_CRC';
                this.field = new Uint8Array(CHUNK_CRC_BYTES);
                this.fieldOffset = 0;
            }
            return amount;
        }

        prepareChunk() {
            if (!this.currentTypeBytes.every(isChunkTypeByte)) throw new PngStructuralError('PNG chunk type contains a non-letter byte.');
            if (this.iendSeen) throw new PngStructuralError('PNG chunk appeared after IEND.');
            if (!this.ihdr && this.currentType !== CHUNK_IHDR) throw new PngStructuralError('IHDR must be the first PNG chunk.');
            if (isCriticalType(this.currentTypeBytes) && ![CHUNK_IHDR, CHUNK_PLTE, CHUNK_IDAT, CHUNK_IEND].includes(this.currentType)) {
                throw new PngStructuralError(`Unknown critical PNG chunk: ${this.currentType}`);
            }
            if (this.currentType === CHUNK_IHDR) {
                if (this.ihdr || this.currentChunkOffset !== PNG_SIGNATURE_LENGTH || this.currentLength !== IHDR_DATA_LENGTH) {
                    throw new PngStructuralError('PNG IHDR framing or order is invalid.');
                }
                this.currentData = new Uint8Array(IHDR_DATA_LENGTH);
            } else if (this.currentType === CHUNK_IEND) {
                if (!this.ihdr || this.iendSeen || this.currentLength !== IEND_DATA_LENGTH || !this.idatSeen ||
                    (this.ihdr.colorType === 3 && !this.plteSeen)) {
                    throw new PngStructuralError('PNG IEND framing or order is invalid.');
                }
            } else if (this.currentType === CHUNK_PLTE) {
                if (this.plteSeen || this.idatSeen || this.currentChunkOffset < PNG_SIGNATURE_LENGTH ||
                    this.currentLength < MIN_PLTE_ENTRIES * PLTE_ENTRY_BYTES ||
                    this.currentLength > MAX_PLTE_ENTRIES * PLTE_ENTRY_BYTES ||
                    this.currentLength % PLTE_ENTRY_BYTES !== 0) {
                    throw new PngStructuralError('PNG PLTE framing or order is invalid.');
                }
                const entryCount = this.currentLength / PLTE_ENTRY_BYTES;
                if (this.ihdr.colorType === 3 &&
                    entryCount > PNG_PALETTE_MAX_ENTRIES[this.ihdr.bitDepth]) {
                    throw new PngStructuralError('PNG PLTE has too many entries for indexed color.');
                }
                this.plteSeen = true;
                this.plteEntryCount = entryCount;
            } else if (this.currentType === CHUNK_IDAT) {
                if (!this.ihdr || this.idatEnded || (this.ihdr.colorType === 3 && !this.plteSeen)) {
                    throw new PngStructuralError('PNG IDAT framing or order is invalid.');
                }
                this.idatSeen = true;
                this.idatOpen = true;
                this.idatChunkOffset = this.currentChunkOffset;
                this.ensureIdatProcessor();
            } else if (this.currentType === CHUNK_TEXT || this.currentType === CHUNK_ITXT) {
                if (this.currentLength <= MAX_TEXT_CHUNK_BYTES) this.currentData = new Uint8Array(this.currentLength);
                else {
                    this.currentData = null;
                    addTextDiagnostic(this.collector, this.currentType, this.currentChunkOffset, 'text chunk input exceeds limit', null, 'MAX_TEXT_CHUNK_BYTES', this.currentLength);
                }
            }
            if (this.currentType !== CHUNK_IDAT && this.idatOpen) this.finishIdat();
            this.currentCrcState = globalObject.createCrc32State();
            this.currentCrcState = globalObject.updateCrc32(this.currentCrcState, this.currentTypeBytes);
        }

        ensureIdatProcessor() {
            if (this.stealthStopped) return;
            if (!this.idatInflate) {
                this.rowAssembler = this.layout
                    ? new RowAssembler(this.layout, this.candidates, this.collector)
                    : null;
                this.idatStructureValidator = this.layout
                    ? null
                    : new DecodedRowValidator(this.structureLayout);
                this.idatInflate = createInflate(
                    this.rowAssembler || this.idatStructureValidator,
                    () => this.idatChunkOffset,
                );
            }
        }

        consumeData(bytes, cursor) {
            const remaining = this.currentLength - this.currentDataOffset;
            const amount = Math.min(bytes.length - cursor, remaining);
            const slice = bytes.subarray(cursor, cursor + amount);
            this.currentCrcState = globalObject.updateCrc32(this.currentCrcState, slice);
            if (this.currentData && this.currentType !== CHUNK_IDAT) {
                this.currentData.set(slice, this.currentDataOffset);
            }
            if (this.currentType === CHUNK_IDAT && this.idatInflate) {
                if (this.idatInflate.ended) {
                    throw new PngStructuralError(
                        'PNG IDAT contains data after the zlib stream ended.',
                        this.idatChunkOffset,
                    );
                }
                const pushed = this.idatInflate.push(slice, false);
                if (!pushed || this.idatInflate.err !== 0) {
                    throw new PngStructuralError('PNG IDAT zlib stream is invalid.', this.idatChunkOffset);
                }
                if (this.idatInflate.ended && this.idatInflate.strm && this.idatInflate.strm.avail_in > 0) {
                    throw new PngStructuralError(
                        'PNG IDAT contains data after the zlib stream ended.',
                        this.idatChunkOffset,
                    );
                }
                this.checkStealthStop();
            }
            this.currentDataOffset += amount;
            this.offset += amount;
            if (this.currentDataOffset === this.currentLength) {
                this.state = 'CHUNK_CRC';
                this.field = new Uint8Array(CHUNK_CRC_BYTES);
                this.fieldOffset = 0;
            }
            return amount;
        }

        completeChunk(crcBytes) {
            const expectedCrc = readUint32(crcBytes, 0);
            const actualCrc = globalObject.finalizeCrc32(this.currentCrcState) >>> 0;
            if (actualCrc !== expectedCrc) {
                if (this.currentType === CHUNK_TEXT || this.currentType === CHUNK_ITXT) {
                    const keyword = this.currentData ? getSafeTextKeyword(this.currentData) : null;
                    addTextDiagnostic(
                        this.collector,
                        this.currentType,
                        this.currentChunkOffset,
                        'text chunk CRC mismatch',
                        keyword,
                    );
                } else if (isCriticalType(this.currentTypeBytes)) {
                    throw new PngStructuralError(`Critical PNG chunk CRC mismatch: ${this.currentType}`);
                } else {
                    this.collector.add({ category: 'ancillary-crc-ignored', chunkType: this.currentType, offset: this.currentChunkOffset, detail: 'CRC mismatch' });
                }
            } else {
                this.acceptChunk();
            }
            this.currentType = null;
            this.currentTypeBytes = null;
            this.currentData = null;
            this.currentDataOffset = 0;
            this.currentCrcState = null;
            if (this.state !== 'DONE') this.state = 'CHUNK_LENGTH';
        }

        acceptChunk() {
            if (this.currentType === CHUNK_IHDR) this.acceptIhdr();
            else if (this.currentType === CHUNK_TEXT || this.currentType === CHUNK_ITXT) {
                if (this.currentData) parseTextChunk(this.currentType, this.currentData, this.currentChunkOffset, this.collector, this.metadata);
            } else if (this.currentType === CHUNK_IEND) {
                this.iendSeen = true;
                this.analysisEndReason = END_VALID_IEND;
                this.state = 'DONE';
            }
        }

        acceptIhdr() {
            const data = this.currentData;
            const width = readUint32(data, 0);
            const height = readUint32(data, 4);
            const bitDepth = data[8];
            const colorType = data[9];
            const compression = data[10];
            const filter = data[11];
            const interlace = data[12];
            if (compression !== 0 || filter !== 0) throw new PngStructuralError('PNG IHDR compression or filter method is invalid.');
            if (!isValidIhdrCombination(bitDepth, colorType, interlace)) {
                throw new PngStructuralError('PNG IHDR bit depth, color type, or interlace method is invalid.');
            }
            this.ihdr = { width, height, bitDepth, colorType, interlace };
            this.layout = makeLayout(width, height, bitDepth, colorType, interlace, this.collector, this.currentChunkOffset);
            this.structureLayout = makeStructureLayout(
                width,
                height,
                bitDepth,
                colorType,
                interlace,
                this.currentChunkOffset,
            );
            if (this.layout) {
                const totalRgbBits = width * height * 3;
                const totalAlphaBits = width * height;
                this.candidates = [];
                for (const mode of this.layout.candidates) {
                    this.candidates.push(makeCandidate(mode, width, height, mode === 'RGB' ? totalRgbBits : totalAlphaBits));
                }
            }
        }

        checkStealthStop() {
            if (this.stealthStopped || !this.layout || !this.rowAssembler) return;
            const completed = this.candidates.find((candidate) => candidate.state === 'COMPLETE' && candidate.result);
            const diagnosticOffset = this.idatChunkOffset === null ? this.offset : this.idatChunkOffset;
            if (completed) {
                this.stealthResult = completed.result;
                this.stealthStopped = true;
                this.validateIdatAfterStealth = true;
                releaseCandidates(this.candidates, diagnosticOffset, completed);
                // Stealth候補だけを停止し、zlib・row構造検証用の状態はIENDまで保持する。
                return;
            }
            if (allCandidatesRejected(this.candidates)) {
                this.stealthStopped = true;
                this.analysisEndReason = END_INTENTIONAL_STOP;
                this.collector.add({ category: 'intentional-stealth-stop', offset: diagnosticOffset });
                releaseCandidates(this.candidates, diagnosticOffset);
                this.idatInflate = null;
                this.rowAssembler = null;
            }
        }

        finishIdat() {
            this.idatEnded = true;
            this.idatOpen = false;
            if (!this.idatInflate) {
                this.rowAssembler = null;
                this.idatStructureValidator = null;
                return;
            }
            if (!this.idatInflate.ended) {
                const finished = this.idatInflate.push(new Uint8Array(0), true);
                if (!finished && this.idatInflate.err === 0) {
                    throw new PngStructuralError('PNG IDAT zlib stream did not finish.', this.idatChunkOffset);
                }
            }
            if (this.idatInflate.err !== 0 || !this.idatInflate.ended) {
                throw new PngStructuralError('PNG IDAT zlib stream is incomplete.', this.idatChunkOffset);
            }
            if (this.rowAssembler && (this.rowAssembler.scanlineOffset !== 0 || this.rowAssembler.rowsCompleted !== this.layout.height ||
                this.rowAssembler.decodedBytes !== this.layout.height * (this.layout.rowBytes + 1))) {
                throw new PngStructuralError(
                    'PNG IDAT decoded size does not match IHDR.',
                    this.idatChunkOffset,
                );
            }
            if (this.idatStructureValidator) this.idatStructureValidator.assertComplete();
            this.checkStealthStop();
            this.idatInflate = null;
            this.rowAssembler = null;
            this.idatStructureValidator = null;
        }

        finishInput() {
            if (this.state !== 'DONE') {
                this.analysisEndReason = END_TRUNCATED;
                this.state = 'INVALID';
                return this.makeResult();
            }
            return this.makeResult();
        }

        makeResult() {
            const diagnosticOffset = this.idatChunkOffset === null ? this.offset : this.idatChunkOffset;
            if (this.iendSeen && this.analysisEndReason === END_VALID_IEND) {
                flushCandidateReleaseDiagnostics(
                    this.candidates,
                    this.collector,
                    this.stealthResult,
                );
            }
            const diagnostics = this.collector.snapshot();
            if (this.analysisEndReason === END_TRUNCATED) {
                return { status: STATUS_INVALID, reason: 'truncated', diagnostics };
            }
            if (this.analysisEndReason === END_STRUCTURAL) {
                return { status: STATUS_INVALID, reason: 'structural', diagnostics };
            }
            if (this.analysisEndReason === END_RESOURCE) {
                return { status: STATUS_RESOURCE_LIMIT, limit: this.resourceLimit, observed: this.resourceObserved, diagnostics };
            }
            if (!this.iendSeen) return { status: STATUS_INVALID, reason: 'truncated', diagnostics };
            if (Object.keys(this.metadata).length > 0) {
                return { status: STATUS_NORMAL, metadata: this.metadata, diagnostics };
            }
            if (this.stealthResult) {
                const metadata = Object.create(null);
                metadata[this.stealthResult.key] = this.stealthResult.value;
                return { status: STATUS_STEALTH, metadata, diagnostics };
            }
            return { status: STATUS_NOT_FOUND, diagnostics };
        }
    }

    function appendResourceDiagnostic(scanner, error) {
        const priorDiagnostics = scanner.collector.snapshot();
        scanner.collector.add({
            category: 'whole-scan-resource-limit',
            limit: error.limit,
            observed: error.observed,
            offset: error.offset === undefined ? scanner.currentChunkOffset : error.offset,
            priorDiagnostics,
        });
        scanner.analysisEndReason = END_RESOURCE;
        scanner.resourceLimit = error.limit;
        scanner.resourceObserved = error.observed;
        scanner.state = 'INVALID';
    }

    function appendStructuralDiagnostic(scanner, error) {
        scanner.collector.add({
            category: 'structural-invalidity',
            offset: error.offset === undefined ? scanner.currentChunkOffset : error.offset,
            detail: error.message,
        });
        scanner.analysisEndReason = END_STRUCTURAL;
        scanner.state = 'INVALID';
    }

    function scanWithScanner(scanner, input) {
        try {
            scanner.feed(input);
            return scanner.finishInput();
        } catch (error) {
            if (error instanceof PngResourceLimitError) {
                appendResourceDiagnostic(scanner, error);
                return scanner.makeResult();
            }
            if (error instanceof PngStructuralError) {
                appendStructuralDiagnostic(scanner, error);
                return scanner.makeResult();
            }
            throw error;
        }
    }

    function scanPngMetadataBuffer(buffer, options) {
        requireDependencies();
        const scanner = new PngChunkScanner(options);
        return scanWithScanner(scanner, toUint8Array(buffer));
    }

    /**
     * abort由来の失敗を呼び出し側が識別できるようにする。
     * abort結果をsuccessやnot-foundへ変換させないため、名前を固定する。
     * @param {string} message - エラーメッセージ
     * @returns {Error}
     */
    function createAbortError(message) {
        const error = new Error(message);
        error.name = 'AbortError';
        return error;
    }

    async function cancelReader(reader) {
        try {
            await reader.cancel();
        } catch (error) {
            // 解析失敗時のreader解放を優先し、cancel失敗は結果を上書きしない。
        }
    }

    async function scanPngMetadataStream(readableStream, options) {
        requireDependencies();
        if (!readableStream || typeof readableStream.getReader !== 'function') {
            throw new TypeError('PNG scanner stream input must be a ReadableStream.');
        }
        const scanner = new PngChunkScanner(options);
        const reader = readableStream.getReader();
        // 異常終了（abort、read rejection、予期しない例外）では下流bodyを止めるため
        // cancelしてからreleaseする。cancel失敗は元の失敗理由を上書きしない。
        let readerCancelled = false;
        let terminatedNormally = false;
        try {
            while (true) {
                scanner.checkAbort();
                const record = await reader.read();
                if (record.done) break;
                if (record.value === undefined || record.value === null) {
                    throw new TypeError('PNG scanner stream returned an empty chunk value.');
                }
                try {
                    scanner.feed(record.value);
                } catch (error) {
                    if (error instanceof PngResourceLimitError) {
                        appendResourceDiagnostic(scanner, error);
                        await cancelReader(reader);
                        readerCancelled = true;
                        terminatedNormally = true;
                        return scanner.makeResult();
                    }
                    if (error instanceof PngStructuralError) {
                        appendStructuralDiagnostic(scanner, error);
                        await cancelReader(reader);
                        readerCancelled = true;
                        terminatedNormally = true;
                        return scanner.makeResult();
                    }
                    throw error;
                }
                if (scanner.state === 'DONE') {
                    terminatedNormally = true;
                    return scanner.makeResult();
                }
            }
            const result = scanner.finishInput();
            terminatedNormally = true;
            return result;
        } finally {
            if (!terminatedNormally && !readerCancelled) {
                await cancelReader(reader);
            }
            reader.releaseLock();
        }
    }

    globalObject.scanPngMetadataBuffer = scanPngMetadataBuffer;
    globalObject.scanPngMetadataStream = scanPngMetadataStream;
    globalObject.PNG_METADATA_SCANNER_CONSTANTS = Object.freeze({
        MAX_PNG_DIMENSION,
        MAX_ROW_BYTES,
        MAX_STEALTH_COMPRESSED_BYTES,
        MAX_STEALTH_METADATA_BYTES,
        MAX_TEXT_CHUNK_BYTES,
        ANALYSIS_END_REASONS: Object.freeze([
            END_VALID_IEND,
            END_TRUNCATED,
            END_STRUCTURAL,
            END_RESOURCE,
            END_INTENTIONAL_STOP,
        ]),
        STEALTH_SIGNATURES,
    });
})(typeof globalThis !== 'undefined' ? globalThis : self);
