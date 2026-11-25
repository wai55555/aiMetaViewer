/*
 * Bounded MP4/WebM metadata parser. This file is imported by background.js;
 * all offsets are relative to the original media resource unless noted.
 */

const VIDEO_METADATA_MAX_BYTES = 2 * 1024 * 1024;
const VIDEO_METADATA_HEAD_BYTES = 256 * 1024;
const WEBM_MAX_RANGE_READS = 64;
const WEBM_MAX_TAG_BYTES = 256 * 1024;
const VIDEO_MAX_BOXES = 20000;
const WEBM_MAX_ELEMENTS = 50000;
const WEBM_MAX_DEPTH = 16;

function videoBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    return new Uint8Array(0);
}

function videoParserResult(metadata, state, details = {}) {
    Object.defineProperty(metadata, 'parserState', {
        value: state,
        enumerable: false,
        configurable: true,
    });
    for (const [key, value] of Object.entries(details)) {
        Object.defineProperty(metadata, key, {
            value,
            enumerable: false,
            configurable: true,
        });
    }
    return metadata;
}

function videoUInt32(bytes, offset) {
    if (offset < 0 || offset + 4 > bytes.length) return null;
    return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
}

function videoUInt16(bytes, offset) {
    if (offset < 0 || offset + 2 > bytes.length) return null;
    return bytes[offset] * 0x100 + bytes[offset + 1];
}

function videoUInt64(bytes, offset) {
    if (offset < 0 || offset + 8 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const value = view.getBigUint64(offset, false);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function videoAscii(bytes, start, end) {
    let value = '';
    for (let i = start; i < end; i++) value += String.fromCharCode(bytes[i]);
    return value;
}

function videoDecodeText(bytes) {
    try {
        return new TextDecoder('utf-8').decode(bytes).replace(/\0+$/g, '').trim();
    } catch (_) {
        return videoAscii(bytes, 0, bytes.length).replace(/\0+$/g, '').trim();
    }
}

function videoDecodeUtf16Be(bytes) {
    const evenLength = bytes.length - (bytes.length % 2);
    let value = '';
    for (let i = 0; i < evenLength; i += 2) value += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return value.replace(/\0+$/g, '').trim();
}

function videoDecodeQuickTimeUserDataText(bytes, languageCode) {
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
        return videoDecodeUtf16Be(bytes.subarray(2));
    }
    if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
        try { return new TextDecoder('utf-16le').decode(bytes.subarray(2)).replace(/\0+$/g, '').trim(); }
        catch (_) { return videoDecodeText(bytes.subarray(2)); }
    }
    const encoding = languageCode < 0x400 || languageCode === 0x7FFF ? 'macintosh' : 'utf-8';
    try { return new TextDecoder(encoding).decode(bytes).replace(/\0+$/g, '').trim(); }
    catch (_) { return videoDecodeText(bytes); }
}

function readIsoBox(bytes, offset, parentEnd, { complete = false } = {}) {
    if (offset < 0 || offset + 8 > parentEnd || offset + 8 > bytes.length) return { incomplete: true };
    let size = videoUInt32(bytes, offset);
    const type = videoAscii(bytes, offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
        if (offset + 16 > parentEnd) return { invalid: true, type, start: offset };
        if (offset + 16 > bytes.length) return { incomplete: true, type, start: offset, headerSize: 16 };
        size = videoUInt64(bytes, offset + 8);
        if (size === null) return { invalid: true, type, start: offset };
        headerSize = 16;
    } else if (size === 0) {
        if (!complete) return { incomplete: true };
        size = parentEnd - offset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize) return { invalid: true };
    const end = offset + size;
    if (!Number.isSafeInteger(end) || end > parentEnd) return { invalid: true };
    if (end > bytes.length) return { incomplete: true, type, size, headerSize, end, start: offset };
    return { type, size, headerSize, start: offset, payloadStart: offset + headerSize, end };
}

function readMp4BoxHeader(input, { absoluteOffset = 0, totalSize = null } = {}) {
    const bytes = videoBytes(input);
    if (!Number.isSafeInteger(absoluteOffset) || absoluteOffset < 0) return { state: 'invalid' };
    if (bytes.length < 8) return { state: 'incomplete' };
    let size = videoUInt32(bytes, 0);
    const type = videoAscii(bytes, 4, 8);
    let headerSize = 8;
    if (size === 1) {
        if (bytes.length < 16) return { state: 'incomplete', type };
        size = videoUInt64(bytes, 8);
        if (size === null) return { state: 'invalid', type };
        headerSize = 16;
    } else if (size === 0) {
        if (!Number.isSafeInteger(totalSize) || totalSize < absoluteOffset) return { state: 'unresolved', type };
        size = totalSize - absoluteOffset;
    }
    if (!Number.isSafeInteger(size) || size < headerSize) return { state: 'invalid', type };
    const end = absoluteOffset + size;
    if (!Number.isSafeInteger(end) || (Number.isSafeInteger(totalSize) && end > totalSize)) return { state: 'invalid', type };
    return {
        state: bytes.length >= size ? 'complete' : 'incomplete',
        type,
        size,
        headerSize,
        start: absoluteOffset,
        end,
    };
}

function readIsoBoxes(bytes, start, end, options = {}) {
    const boxes = [];
    let offset = start;
    let count = 0;
    while (offset < end) {
        if (++count > VIDEO_MAX_BOXES) return { boxes, state: 'resource-limit' };
        const box = readIsoBox(bytes, offset, end, options);
        if (box.incomplete) return { boxes, state: 'unresolved' };
        if (box.invalid || !box.type || box.end <= offset) return { boxes, state: 'invalid' };
        boxes.push(box);
        offset = box.end;
    }
    return { boxes, state: offset === end ? 'complete' : 'invalid' };
}

function parseIsoKeys(bytes, box) {
    const payloadStart = box.payloadStart;
    if (payloadStart + 8 > box.end) return null;
    const count = videoUInt32(bytes, payloadStart + 4);
    if (count === null || count > 4096) return null;
    const keys = [];
    let offset = payloadStart + 8;
    for (let i = 0; i < count; i++) {
        if (offset + 8 > box.end) return null;
        const entrySize = videoUInt32(bytes, offset);
        if (!entrySize || entrySize < 8 || offset + entrySize > box.end) return null;
        // The four-byte namespace precedes each key string.
        keys.push(videoDecodeText(bytes.subarray(offset + 8, offset + entrySize)));
        offset += entrySize;
    }
    return keys;
}

function parseIsoDataText(bytes, dataBox) {
    const start = dataBox.payloadStart;
    if (start + 8 > dataBox.end) return null;
    const typeFlags = videoUInt32(bytes, start);
    const textBytes = bytes.subarray(start + 8, dataBox.end);
    const textType = typeFlags == null ? 0 : typeFlags & 0xFFFFFF;
    if (![0, 1, 2].includes(textType)) return null;
    return textType === 2 ? videoDecodeUtf16Be(textBytes) : videoDecodeText(textBytes);
}

function looksLikeComfyValue(value) {
    let parsed = value;
    if (typeof parsed === 'string') {
        const trimmed = parsed.trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
        try { parsed = JSON.parse(trimmed); } catch (_) { return false; }
    }
    if (!parsed || typeof parsed !== 'object') return false;
    if (Array.isArray(parsed.nodes)) return true;
    if (parsed.prompt && parsed.workflow) return true;
    return Object.values(parsed).some(node => node && typeof node === 'object' && (node.class_type || node.inputs));
}

function mergeComfyPayload(metadata, text) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed.startsWith('{')) return false;
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch (_) { return false; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

    let found = false;
    if (parsed.prompt !== undefined) {
        metadata.prompt = parsed.prompt;
        found = true;
    }
    if (parsed.workflow !== undefined) {
        metadata.workflow = parsed.workflow;
        found = true;
    } else if (Array.isArray(parsed.nodes)) {
        metadata.workflow = parsed;
        found = true;
    }
    if (!found && looksLikeComfyValue(parsed)) {
        metadata.workflow = parsed;
        found = true;
    }
    if (found) metadata.generator = 'ComfyUI';
    return found;
}

function assignVideoTag(metadata, key, text) {
    const normalized = String(key || '').trim();
    if (!normalized || !text) return;
    if (/^comfyui[/:.]/i.test(normalized)) metadata.generator = 'ComfyUI';
    const leafName = normalized.split(/[/:.]/).pop();
    const lower = leafName.toLowerCase().replace(/[\s_.-]/g, '');
    if (lower === 'prompt' || lower === 'mdtaprompt' || lower === 'positiveprompt') {
        metadata.prompt = text;
    } else if (lower === 'workflow' || lower === 'mdtaworkflow') {
        metadata.workflow = text;
        metadata.generator = 'ComfyUI';
    } else if (lower === 'negativeprompt' || lower === 'uc') {
        metadata.negative_prompt = text;
    } else if (lower === 'parameters' || lower === 'generationparameters') {
        metadata.parameters = text;
        if (/Version:\s*ComfyUI/i.test(text)) metadata.generator = 'ComfyUI';
    } else if (lower === 'model' || lower === 'modelname') {
        metadata.model = text;
    } else if (lower === 'description' || lower === 'comment' || lower === '©cmt') {
        if (!mergeComfyPayload(metadata, text)) metadata.Description = text;
    } else {
        metadata[`Video Tag: ${normalized}`] = text;
    }
    if (looksLikeComfyValue(text)) {
        if (['prompt', 'mdtaprompt', 'positiveprompt', 'workflow', 'mdtaworkflow'].includes(lower)) {
            // The tag already identifies the field. Keep its source string intact;
            // the UI summary parser can inspect it without creating a duplicate field.
            metadata.generator = 'ComfyUI';
        } else {
            mergeComfyPayload(metadata, text);
            if (metadata.workflow || (metadata.prompt && typeof metadata.prompt === 'object')) metadata.generator = 'ComfyUI';
        }
    }
}

function parseIsoIlst(bytes, ilstBox, keys, metadata) {
    const itemList = readIsoBoxes(bytes, ilstBox.payloadStart, ilstBox.end, { complete: true });
    if (itemList.state !== 'complete') return false;
    for (const item of itemList.boxes) {
        const indexedItem = item.type.length === 4 && item.type.charCodeAt(0) === 0 &&
            item.type.charCodeAt(1) === 0 && item.type.charCodeAt(2) === 0;
        const keyIndex = indexedItem ? videoUInt32(bytes, item.start + 4) : null;
        if (indexedItem && (!keyIndex || !keys || !keys[keyIndex - 1])) return false;
        const key = keyIndex && keys && keys[keyIndex - 1]
            ? keys[keyIndex - 1]
            : item.type;
        const childStart = item.payloadStart;
        const children = readIsoBoxes(bytes, childStart, item.end, { complete: true });
        if (children.state !== 'complete') return false;
        for (const child of children.boxes) {
            if (child.type !== 'data') continue;
            if (child.end - child.payloadStart < 8) return false;
            const text = parseIsoDataText(bytes, child);
            if (text) assignVideoTag(metadata, key, text);
        }
    }
    return true;
}

function parseIsoMeta(bytes, metaBox, metadata) {
    const childStart = metaBox.payloadStart + 4; // FullBox version/flags
    if (childStart > metaBox.end) return false;
    const children = readIsoBoxes(bytes, childStart, metaBox.end, { complete: true });
    if (children.state !== 'complete') return false;
    let keys = null;
    let ilst = null;
    for (const child of children.boxes) {
        if (child.type === 'keys') {
            keys = parseIsoKeys(bytes, child);
            if (!keys) return false;
        }
        if (child.type === 'ilst') ilst = child;
    }
    if (!ilst) return true;
    return parseIsoIlst(bytes, ilst, keys, metadata);
}

function parseIsoUdta(bytes, udtaBox, metadata) {
    const children = readIsoBoxes(bytes, udtaBox.payloadStart, udtaBox.end, { complete: true });
    if (children.state !== 'complete') return false;
    for (const child of children.boxes) {
        if (child.type === 'meta') {
            if (!parseIsoMeta(bytes, child, metadata)) return false;
        } else if (child.type === '©cmt' || child.type === 'desc') {
            if (child.type === '©cmt' && parseQuickTimeUserDataText(bytes, child, metadata)) continue;
            const nested = readIsoBoxes(bytes, child.payloadStart, child.end, { complete: true });
            if (nested.state !== 'complete') return false;
            for (const data of nested.boxes) {
                if (data.type === 'data') {
                    if (data.end - data.payloadStart < 8) return false;
                    const text = parseIsoDataText(bytes, data);
                    if (text) assignVideoTag(metadata, child.type, text);
                }
            }
        }
    }
    return true;
}

function parseQuickTimeUserDataText(bytes, atom, metadata) {
    let offset = atom.payloadStart;
    let entryCount = 0;
    while (offset < atom.end) {
        if (++entryCount > 4096 || offset + 4 > atom.end) return false;
        const entrySize = videoUInt16(bytes, offset);
        const languageCode = videoUInt16(bytes, offset + 2);
        if (entrySize === null || languageCode === null || entrySize < 4 || offset + entrySize > atom.end) return false;
        const text = videoDecodeQuickTimeUserDataText(
            bytes.subarray(offset + 4, offset + entrySize),
            languageCode
        );
        if (text) assignVideoTag(metadata, atom.type, text);
        offset += entrySize;
    }
    return offset === atom.end;
}

function parseMp4Moov(bytes, moovBox, metadata) {
    const children = readIsoBoxes(bytes, moovBox.payloadStart, moovBox.end, { complete: true });
    if (children.state !== 'complete') return false;
    for (const child of children.boxes) {
        if (child.type === 'udta' && !parseIsoUdta(bytes, child, metadata)) return false;
        else if (child.type === 'meta' && !parseIsoMeta(bytes, child, metadata)) return false;
    }
    return true;
}

function findMp4Moov(bytes, startOffset, totalSize, inputComplete, atBoxBoundary = false) {
    const exceedsTotalSize = box => Number.isSafeInteger(totalSize) &&
        Number.isSafeInteger(box?.end) && startOffset + box.end > totalSize;
    if (startOffset === 0) {
        let offset = 0;
        let count = 0;
        while (offset + 8 <= bytes.length && count++ < VIDEO_MAX_BOXES) {
            const box = readIsoBox(bytes, offset, inputComplete ? bytes.length : Number.MAX_SAFE_INTEGER, { complete: inputComplete });
            if (box.invalid || exceedsTotalSize(box)) return { state: 'invalid' };
            if (box.incomplete) return box.type === 'moov'
                ? { state: 'unresolved', box }
                : { state: 'unresolved', nextBoxOffset: Number.isSafeInteger(box.end) ? box.end : startOffset + offset };
            if (box.type === 'moov') return { box, state: 'found' };
            if (!box.size || box.end <= offset) return { state: 'invalid' };
            offset = box.end;
            if (offset > bytes.length) return { state: 'unresolved' };
        }
        if (count >= VIDEO_MAX_BOXES && offset + 8 <= bytes.length) return { state: 'resource-limit' };
        if (offset !== bytes.length) return { state: inputComplete ? 'invalid' : 'unresolved' };
        return inputComplete
            ? { state: 'empty-confirmed' }
            : { state: 'unresolved', nextBoxOffset: startOffset + offset };
    }

    if (!atBoxBoundary) return { state: 'unresolved' };
    const box = readIsoBox(bytes, 0, inputComplete ? bytes.length : Number.MAX_SAFE_INTEGER, { complete: inputComplete });
    if (box.invalid || exceedsTotalSize(box)) return { state: 'invalid' };
    if (box.incomplete) return box.type === 'moov'
        ? { state: 'unresolved', box }
        : { state: 'unresolved', nextBoxOffset: Number.isSafeInteger(box.end) ? startOffset + box.end : startOffset };
    if (box.type === 'moov') return { box, state: 'found' };
    return { state: 'unresolved', nextBoxOffset: startOffset + box.end };
}

function extractMp4VideoMetadata(input, options = {}) {
    const bytes = videoBytes(input);
    if (bytes.length > VIDEO_METADATA_MAX_BYTES) {
        return videoParserResult({}, 'resource-limit', { format: 'mp4', reason: 'byte-budget' });
    }
    const inputComplete = options.inputComplete === true;
    const startOffset = Number.isSafeInteger(options.startOffset) && options.startOffset >= 0 ? options.startOffset : 0;
    const totalSize = Number.isSafeInteger(options.totalSize) && options.totalSize >= 0 ? options.totalSize : null;
    const metadata = {};
    const found = findMp4Moov(bytes, startOffset, totalSize, inputComplete, options.atBoxBoundary === true);
    if (found.state === 'invalid') return videoParserResult(metadata, 'unresolved', { format: 'mp4', reason: 'invalid-atom' });
    if (found.state === 'resource-limit') return videoParserResult(metadata, 'resource-limit', { format: 'mp4', reason: 'atom-limit' });
    if (found.state === 'unresolved' && found.box?.type === 'moov') {
        return videoParserResult(metadata, 'unresolved', {
            format: 'mp4',
            reason: 'incomplete-moov',
            moovStart: startOffset + found.box.start,
            moovSize: found.box.size,
        });
    }
    if (found.state === 'unresolved' && Number.isSafeInteger(found.nextBoxOffset)) {
        return videoParserResult(metadata, 'unresolved', { format: 'mp4', nextBoxOffset: found.nextBoxOffset, reason: 'metadata-after-large-atom' });
    }
    if (found.state !== 'found') {
        const details = { format: 'mp4' };
        if (Number.isSafeInteger(found.nextBoxOffset)) details.nextBoxOffset = found.nextBoxOffset;
        if (found.state === 'resource-limit') details.reason = 'atom-limit';
        return videoParserResult(metadata, found.state, details);
    }
    if (!parseMp4Moov(bytes, found.box, metadata)) {
        return videoParserResult(metadata, 'unresolved', { format: 'mp4', reason: 'incomplete-moov' });
    }
    if (Object.keys(metadata).length > 0) return videoParserResult(metadata, 'resolved', { format: 'mp4' });
    return videoParserResult({}, inputComplete ? 'empty-confirmed' : 'unresolved', { format: 'mp4' });
}

async function scanMp4VideoMetadata(readRange, totalSize, options = {}) {
    const requestedBudget = Number.isSafeInteger(options.maxBytes) ? Math.max(0, options.maxBytes) : VIDEO_METADATA_MAX_BYTES;
    const requestedBoxes = Number.isSafeInteger(options.maxBoxes) ? Math.max(0, options.maxBoxes) : 64;
    const maxBytes = Math.min(requestedBudget, VIDEO_METADATA_MAX_BYTES);
    const maxBoxes = Math.min(requestedBoxes, 64);
    const startOffset = Number.isSafeInteger(options.startOffset) && options.startOffset >= 0 ? options.startOffset : 0;
    if (!Number.isSafeInteger(totalSize) || totalSize < startOffset) {
        return videoParserResult({}, 'unresolved', { format: 'mp4', reason: 'file-size-unknown' });
    }
    let offset = startOffset;
    let bytesRead = 0;
    for (let count = 0; count < maxBoxes; count++) {
        if (offset === totalSize) return videoParserResult({}, 'empty-confirmed', { format: 'mp4' });
        const headerLength = Math.min(16, totalSize - offset);
        if (headerLength < 8) return videoParserResult({}, 'unresolved', { format: 'mp4', reason: 'truncated-atom-header' });
        if (bytesRead + headerLength > maxBytes) return videoParserResult({}, 'resource-limit', { format: 'mp4', reason: 'header-byte-budget' });
        const headerBytes = await readRange(offset, headerLength);
        if (!headerBytes) return videoParserResult({}, 'unresolved', { format: 'mp4', reason: 'atom-header-unavailable' });
        const header = videoBytes(headerBytes);
        if (header.length !== headerLength) return videoParserResult({}, 'unresolved', { format: 'mp4', reason: 'short-atom-header' });
        bytesRead += header.length;
        const atom = readMp4BoxHeader(header, { absoluteOffset: offset, totalSize });
        if (!atom || atom.state === 'invalid' || atom.state === 'unresolved' ||
            header.length < 8 || !Number.isSafeInteger(atom.end) || atom.end <= offset) {
            return videoParserResult({}, 'unresolved', { format: 'mp4', reason: 'invalid-atom-header' });
        }
        if (atom.type === 'moov') {
            if (atom.size > maxBytes - bytesRead) return videoParserResult({}, 'resource-limit', { format: 'mp4', reason: 'moov-byte-budget' });
            const moovBytes = await readRange(offset, atom.size);
            if (!moovBytes || videoBytes(moovBytes).length !== atom.size) {
                return videoParserResult({}, 'unresolved', { format: 'mp4', reason: 'moov-unavailable' });
            }
            bytesRead += atom.size;
            return extractMp4VideoMetadata(moovBytes, {
                format: 'mp4',
                startOffset: offset,
                totalSize,
                inputComplete: true,
                atBoxBoundary: true,
            });
        }
        offset = atom.end;
    }
    return offset === totalSize
        ? videoParserResult({}, 'empty-confirmed', { format: 'mp4' })
        : videoParserResult({}, 'resource-limit', { format: 'mp4', reason: 'atom-scan-limit' });
}

function readEbmlVint(bytes, offset, isId = false) {
    if (offset < 0 || offset >= bytes.length) return null;
    const first = bytes[offset];
    if (first === 0) return null;
    let mask = 0x80;
    let length = 1;
    while (length <= (isId ? 4 : 8) && (first & mask) === 0) {
        mask >>= 1;
        length++;
    }
    if (length > (isId ? 4 : 8) || offset + length > bytes.length) return null;
    let value = BigInt(isId ? first : first & (mask - 1));
    for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(bytes[offset + i]);
    const unknown = !isId && value === (1n << BigInt(7 * length)) - 1n;
    if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return { value: unknown ? null : Number(value), length, unknown };
}

function readEbmlElement(bytes, offset, parentEnd) {
    const id = readEbmlVint(bytes, offset, true);
    if (!id) return { state: 'unresolved' };
    const size = readEbmlVint(bytes, offset + id.length, false);
    if (!size) return { state: 'unresolved' };
    const headerLength = id.length + size.length;
    const dataStart = offset + headerLength;
    if (dataStart > parentEnd || dataStart > bytes.length) return { state: 'invalid' };
    if (size.unknown) return { state: 'unknown-size', id: id.value, offset, dataStart, headerLength };
    const end = dataStart + size.value;
    if (!Number.isSafeInteger(end) || end > parentEnd) return { state: 'invalid' };
    if (end > bytes.length) return { state: 'incomplete', id: id.value, offset, dataStart, end, size: size.value, headerLength };
    return { state: 'complete', id: id.value, offset, dataStart, end, size: size.value, headerLength };
}

function readEbmlUnsigned(bytes, start, end) {
    if (end - start < 1 || end - start > 8) return null;
    let value = 0n;
    for (let i = start; i < end; i++) value = (value << 8n) | BigInt(bytes[i]);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function parseWebmSimpleTag(bytes, element, depth = 0, counter = { value: 0 }) {
    if (depth > WEBM_MAX_DEPTH || ++counter.value > WEBM_MAX_ELEMENTS) return { state: 'resource-limit' };
    const tag = { name: '', value: '', children: [] };
    let offset = element.dataStart;
    let childCount = 0;
    while (offset < element.end) {
        if (++childCount > WEBM_MAX_ELEMENTS) return { state: 'resource-limit' };
        const child = readEbmlElement(bytes, offset, element.end);
        if (child.state !== 'complete') return { state: child.state === 'unknown-size' ? 'unresolved' : 'invalid' };
        if (child.id === 0x45A3) tag.name = videoDecodeText(bytes.subarray(child.dataStart, child.end));
        else if (child.id === 0x4487) tag.value = videoDecodeText(bytes.subarray(child.dataStart, child.end));
        else if (child.id === 0x4485) tag.binaryLength = child.size;
        else if (child.id === 0x67C8) {
            const nested = parseWebmSimpleTag(bytes, child, depth + 1, counter);
            if (nested.state !== 'complete') return nested;
            tag.children.push(nested.tag);
        }
        offset = child.end;
    }
    return { state: 'complete', tag };
}

function flattenWebmTag(tag, prefix = '', output = []) {
    const name = String(tag.name || '').trim();
    const path = prefix ? `${prefix}/${name}` : name;
    if (name && (tag.value || Number.isSafeInteger(tag.binaryLength))) {
        output.push({
            name: path,
            ...(tag.value ? { value: tag.value } : {}),
            ...(Number.isSafeInteger(tag.binaryLength) ? { binaryLength: tag.binaryLength } : {}),
        });
    }
    for (const child of tag.children || []) flattenWebmTag(child, path, output);
    return output;
}

function parseWebmTagsElement(input, options = {}) {
    const bytes = videoBytes(input);
    if (bytes.length > WEBM_MAX_TAG_BYTES) return videoParserResult({}, 'resource-limit', { format: 'webm', reason: 'tag-byte-budget' });
    const metadata = {};
    const tags = [];
    let offset = 0;
    let counter = { value: 0 };
    let elementCount = 0;
    const parseSimpleTag = element => {
        const parsed = parseWebmSimpleTag(bytes, element, 0, counter);
        if (parsed.state !== 'complete') return parsed.state;
        tags.push(...flattenWebmTag(parsed.tag));
        return 'complete';
    };
    const parseTag = element => {
        let tagOffset = element.dataStart;
        while (tagOffset < element.end) {
            if (++elementCount > WEBM_MAX_ELEMENTS) return 'resource-limit';
            const child = readEbmlElement(bytes, tagOffset, element.end);
            if (child.state !== 'complete') return 'invalid';
            if (child.id === 0x67C8) {
                const state = parseSimpleTag(child);
                if (state !== 'complete') return state;
            }
            tagOffset = child.end;
        }
        return 'complete';
    };
    while (offset < bytes.length) {
        if (++elementCount > WEBM_MAX_ELEMENTS) return videoParserResult(metadata, 'resource-limit', { format: 'webm', reason: 'element-limit' });
        const element = readEbmlElement(bytes, offset, bytes.length);
        if (element.state !== 'complete') return videoParserResult(metadata, 'unresolved', { format: 'webm', reason: 'invalid-tags' });
        if (element.id === 0x1254C367) {
            let tagOffset = element.dataStart;
            while (tagOffset < element.end) {
                if (++elementCount > WEBM_MAX_ELEMENTS) return videoParserResult(metadata, 'resource-limit', { format: 'webm', reason: 'element-limit' });
                const tag = readEbmlElement(bytes, tagOffset, element.end);
                if (tag.state !== 'complete') return videoParserResult(metadata, 'unresolved', { format: 'webm', reason: 'invalid-tag' });
                if (tag.id === 0x7373) {
                    const state = parseTag(tag);
                    if (state !== 'complete') return videoParserResult(metadata, state, { format: 'webm', reason: 'tag-limit' });
                }
                tagOffset = tag.end;
            }
        }
        offset = element.end;
    }

    for (const tag of tags) assignVideoTag(metadata, tag.name, tag.value);
    if (tags.length > 0) metadata['WebM Tags'] = tags;
    if (Object.keys(metadata).length > 0) return videoParserResult(metadata, 'resolved', { format: 'webm' });
    return videoParserResult({}, options.inputComplete === true ? 'empty-confirmed' : 'unresolved', { format: 'webm' });
}

const webmMetadataTagKeys = new WeakMap();

function mergeWebmTagMetadata(target, source) {
    const tags = Array.isArray(source?.['WebM Tags']) ? source['WebM Tags'] : [];
    if (!Array.isArray(target['WebM Tags'])) target['WebM Tags'] = [];
    let seen = webmMetadataTagKeys.get(target);
    if (!seen) {
        seen = new Set(target['WebM Tags'].map(tag => JSON.stringify(tag)));
        webmMetadataTagKeys.set(target, seen);
    }
    for (const tag of tags) {
        if (!tag || typeof tag.name !== 'string' || typeof tag.value !== 'string') continue;
        const key = JSON.stringify(tag);
        if (seen.has(key)) continue;
        seen.add(key);
        target['WebM Tags'].push(tag);
        assignVideoTag(target, tag.name, tag.value);
    }
    return target;
}

function parseEbmlMasterChildren(bytes, start, end, depth = 0) {
    if (depth > WEBM_MAX_DEPTH) return { state: 'resource-limit', children: [] };
    const children = [];
    let offset = start;
    while (offset < end) {
        if (children.length >= WEBM_MAX_ELEMENTS) return { state: 'resource-limit', children };
        const element = readEbmlElement(bytes, offset, end);
        if (element.state !== 'complete') return { state: element.state === 'unknown-size' ? 'unresolved' : element.state, children };
        children.push(element);
        offset = element.end;
    }
    return { state: offset === end ? 'complete' : 'invalid', children };
}

function parseWebmSeekHead(bytes, seekHead) {
    const seekChildren = parseEbmlMasterChildren(bytes, seekHead.dataStart, seekHead.end, 1);
    if (seekChildren.state !== 'complete') return null;
    for (const seek of seekChildren.children) {
        if (seek.id !== 0x4DBB) continue;
        const fields = parseEbmlMasterChildren(bytes, seek.dataStart, seek.end, 2);
        if (fields.state !== 'complete') continue;
        let seekId = null;
        let position = null;
        for (const field of fields.children) {
            if (field.id === 0x53AB) {
                seekId = videoBytes(bytes.subarray(field.dataStart, field.end));
            } else if (field.id === 0x53AC) {
                position = readEbmlUnsigned(bytes, field.dataStart, field.end);
            }
        }
        if (seekId && seekId.length === 4 && seekId[0] === 0x12 && seekId[1] === 0x54 && seekId[2] === 0xC3 && seekId[3] === 0x67 && position !== null) {
            return position;
        }
    }
    return null;
}

/**
 * SeekHeadを先に使い、なければEBML Segmentのelement headerをRangeで走査する。
 * readRange(offset, length)は要求範囲のbytes、または取得不能時にnullを返す。
 */
async function scanWebmVideoMetadata(readRange, totalSize, options = {}) {
    const boundedOption = (value, fallback, limit) => Number.isSafeInteger(value)
        ? Math.max(0, Math.min(value, limit))
        : fallback;
    const maxBytes = boundedOption(options.maxBytes, VIDEO_METADATA_MAX_BYTES, VIDEO_METADATA_MAX_BYTES);
    const maxReads = boundedOption(options.maxReads, WEBM_MAX_RANGE_READS, WEBM_MAX_RANGE_READS);
    const maxTagBytes = boundedOption(options.maxTagBytes, WEBM_MAX_TAG_BYTES, maxBytes);
    if (maxBytes === 0 || maxReads === 0) {
        return videoParserResult({}, 'resource-limit', { format: 'webm', reason: 'range-budget' });
    }
    let reads = 0;
    let bytesRead = 0;
    let budgetBlocked = false;
    const readAt = async (offset, length) => {
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 1) return null;
        if (length > maxBytes) {
            budgetBlocked = true;
            return null;
        }
        if (totalSize !== null && offset + length > totalSize) return null;
        if (reads >= maxReads || bytesRead + length > maxBytes) {
            budgetBlocked = true;
            return null;
        }
        reads++;
        const result = await readRange(offset, length);
        const bytes = result ? videoBytes(result) : null;
        if (!bytes || bytes.length !== length) return null;
        bytesRead += bytes.length;
        return bytes;
    };

    const first = await readAt(0, Math.min(64 * 1024, totalSize || 64 * 1024, maxBytes));
    if (!first) return videoParserResult({}, budgetBlocked ? 'resource-limit' : 'unresolved', { format: 'webm', reason: budgetBlocked ? 'range-budget' : 'range-unavailable' });
    // The first response is generally a prefix rather than a complete EBML document.
    let segment = null;
    let firstOffset = 0;
    while (firstOffset + 2 <= first.length) {
        const item = readEbmlElement(first, firstOffset, totalSize || Number.MAX_SAFE_INTEGER);
        if ((item.state === 'complete' || item.state === 'incomplete' || item.state === 'unknown-size') && item.id === 0x18538067) {
            segment = item;
            break;
        }
        if (item.state !== 'complete') break;
        firstOffset = item.end;
    }
    if (!segment) return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'segment-not-found' });

    const segmentStart = segment.dataStart;
    const declaredSegmentEnd = Number.isSafeInteger(segment.size)
        ? segment.dataStart + segment.size
        : null;
    const segmentEnd = declaredSegmentEnd !== null && totalSize !== null
        ? Math.min(declaredSegmentEnd, totalSize)
        : declaredSegmentEnd ?? totalSize;
    if (!Number.isSafeInteger(segmentEnd) || segmentEnd === null || segmentEnd < segmentStart) {
        return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'segment-size-unknown' });
    }
    const collectedMetadata = {};

    const prefixChildren = [];
    let childOffset = segmentStart;
    while (childOffset + 2 <= first.length) {
        const child = readEbmlElement(first, childOffset, segmentEnd);
        if (child.state !== 'complete') break;
        prefixChildren.push(child);
        childOffset = child.end;
    }
    const seekHead = prefixChildren.find(item => item.id === 0x114D9B74);
    if (seekHead && seekHead.state === 'complete') {
        const tagPosition = parseWebmSeekHead(first, seekHead);
        if (tagPosition !== null) {
            const tagOffset = segmentStart + tagPosition;
            const tagHeaderLength = Number.isSafeInteger(tagOffset) && tagOffset >= segmentStart && tagOffset < segmentEnd
                ? Math.min(12, segmentEnd - tagOffset)
                : 0;
            const tagHeaderBytes = tagHeaderLength >= 2 ? await readAt(tagOffset, tagHeaderLength) : null;
            if (tagHeaderBytes) {
                const tagHeader = readEbmlElement(tagHeaderBytes, 0, Number.MAX_SAFE_INTEGER);
                if (tagHeader.id === 0x1254C367 && ['complete', 'incomplete'].includes(tagHeader.state) &&
                    tagHeader.end <= maxTagBytes && tagHeader.end <= segmentEnd - tagOffset) {
                    const tagBytes = await readAt(tagOffset, tagHeader.end);
                    if (tagBytes) {
                        const tagResult = parseWebmTagsElement(tagBytes, { inputComplete: true });
                        if (tagResult.parserState === 'resolved') mergeWebmTagMetadata(collectedMetadata, tagResult);
                        else if (tagResult.parserState !== 'empty-confirmed') return tagResult;
                    }
                }
            }
        }
    }

    let offset = segmentStart;
    while (offset < segmentEnd) {
        const headerBytes = await readAt(offset, Math.min(12, segmentEnd - offset));
        if (!headerBytes) return videoParserResult({}, budgetBlocked ? 'resource-limit' : 'unresolved', { format: 'webm', reason: budgetBlocked ? 'range-budget' : 'scan-incomplete' });
        const header = readEbmlElement(headerBytes, 0, Number.MAX_SAFE_INTEGER);
        if (header.state === 'unknown-size') return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'unknown-element-size' });
        if (header.state !== 'complete' && header.state !== 'incomplete') {
            return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'invalid-element' });
        }
        if (header.id === 0x1254C367) {
            if (!Number.isSafeInteger(header.end) || header.end > maxTagBytes) {
                return videoParserResult({}, 'resource-limit', { format: 'webm', reason: 'tag-budget' });
            }
            if (header.end > segmentEnd - offset) {
                return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'tag-outside-segment' });
            }
            const tagBytes = await readAt(offset, header.end);
            if (!tagBytes) return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'tag-unavailable' });
            const tagResult = parseWebmTagsElement(tagBytes, { inputComplete: true });
            if (tagResult.parserState === 'resolved') mergeWebmTagMetadata(collectedMetadata, tagResult);
            else if (tagResult.parserState !== 'empty-confirmed') return tagResult;
            offset += header.end;
            continue;
        }
        const elementSize = header.size;
        if (!Number.isSafeInteger(elementSize) || elementSize < 0) {
            return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'invalid-element-size' });
        }
        const next = offset + header.headerLength + elementSize;
        if (!Number.isSafeInteger(next) || next <= offset || next > segmentEnd) {
            return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'element-out-of-bounds' });
        }
        offset = next; // skip Cluster payloads using their validated EBML size
    }
    return Object.keys(collectedMetadata).length > 0
        ? videoParserResult(collectedMetadata, 'resolved', { format: 'webm' })
        : videoParserResult({}, 'empty-confirmed', { format: 'webm' });
}

function extractWebmVideoMetadata(input, options = {}) {
    const bytes = videoBytes(input);
    const inputComplete = options.inputComplete === true;
    if (bytes.length > VIDEO_METADATA_MAX_BYTES) return videoParserResult({}, 'resource-limit', { format: 'webm', reason: 'byte-budget' });
    let offset = 0;
    let segmentFound = false;
    let elementsVisited = 0;
    const scanSegment = (start, end) => {
        const collectedMetadata = {};
        let childOffset = start;
        while (childOffset < end) {
            if (++elementsVisited > WEBM_MAX_ELEMENTS) return videoParserResult({}, 'resource-limit', { format: 'webm', reason: 'element-limit' });
            const child = readEbmlElement(bytes, childOffset, end);
            if (child.state === 'unknown-size') return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'unknown-segment-child-size' });
            if (child.state !== 'complete') return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'truncated-segment-child' });
            if (child.id === 0x1254C367) {
                if (child.size > WEBM_MAX_TAG_BYTES) return videoParserResult({}, 'resource-limit', { format: 'webm', reason: 'tag-byte-budget' });
                const tagsResult = parseWebmTagsElement(bytes.subarray(child.offset, child.end), { inputComplete: true });
                if (tagsResult.parserState === 'resolved') mergeWebmTagMetadata(collectedMetadata, tagsResult);
                else if (tagsResult.parserState !== 'empty-confirmed') return tagsResult;
            }
            childOffset = child.end;
        }
        return Object.keys(collectedMetadata).length > 0
            ? videoParserResult(collectedMetadata, 'resolved', { format: 'webm' })
            : null;
    };
    while (offset < bytes.length) {
        if (++elementsVisited > WEBM_MAX_ELEMENTS) return videoParserResult({}, 'resource-limit', { format: 'webm', reason: 'element-limit' });
        const top = readEbmlElement(bytes, offset, bytes.length);
        if (top.state === 'unknown-size') {
            if (top.id !== 0x18538067 || !inputComplete) return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'unknown-top-level-size' });
            segmentFound = true;
            const result = scanSegment(top.dataStart, bytes.length);
            if (result) return result;
            offset = bytes.length;
            break;
        }
        if (top.state === 'incomplete') return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'truncated-top-level' });
        if (top.state !== 'complete') return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'invalid-top-level' });
        if (top.id === 0x18538067) {
            segmentFound = true;
            const result = scanSegment(top.dataStart, top.end);
            if (result) return result;
        }
        offset = top.end;
    }
    if (!inputComplete) return videoParserResult({}, 'unresolved', { format: 'webm', reason: 'incomplete-input' });
    return videoParserResult({}, segmentFound ? 'empty-confirmed' : 'unresolved', { format: 'webm' });
}

function detectVideoContainer(input) {
    const bytes = videoBytes(input);
    if (bytes.length >= 8) {
        const firstBoxType = videoAscii(bytes, 4, 8);
        if (['ftyp', 'moov', 'mdat', 'free', 'wide', 'skip', 'uuid', 'styp'].includes(firstBoxType)) return 'mp4';
    }
    if (bytes.length >= 4 && bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) return 'webm';
    return null;
}

function extractVideoMetadata(input, options = {}) {
    const bytes = videoBytes(input);
    const format = options.format || detectVideoContainer(bytes);
    if (format === 'mp4') return extractMp4VideoMetadata(bytes, options);
    if (format === 'webm') return extractWebmVideoMetadata(bytes, options);
    return videoParserResult({}, options.inputComplete === false ? 'unresolved' : 'unsupported-format', { format: 'unknown' });
}

const VideoMetadataParser = {
    detectVideoContainer,
    extractVideoMetadata,
    extractMp4VideoMetadata,
    readMp4BoxHeader,
    scanMp4VideoMetadata,
    parseWebmTagsElement,
    extractWebmVideoMetadata,
    scanWebmVideoMetadata,
};
globalThis.VideoMetadataParser = VideoMetadataParser;
if (typeof module !== 'undefined' && module.exports) module.exports = VideoMetadataParser;
