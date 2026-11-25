// parser.js - 画像メタデータ抽出モジュール

/**
 * 対象キーワードリスト (廃止: すべてのメタデータを取得するため)
 */
// const TARGET_KEYWORDS = [ ... ];

/**
 * PNGシグネチャ (89 50 4E 47 0D 0A 1A 0A)
 * 先頭4 bytesだけの一致でPNGと判定してはならない。
 */
const PNG_SIGNATURE = Object.freeze([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

/** ISOBMFFのFileTypeBoxマーカー 'ftyp' */
const FTYP_MARKER = Object.freeze([0x66, 0x74, 0x79, 0x70]);

/**
 * 形式判定に必要な最小prefix長。
 * これ未満のprefixでは当該形式を確定できず「判定不能」として扱う。
 * avifは size(4) + 'ftyp'(4) + major_brand(4) = 12 bytes が必要。
 */
const FORMAT_MIN_PREFIX_BYTES = Object.freeze({
  png: 8,
  jpeg: 3,
  webp: 12,
  avif: 12,
  safetensors: 12,
});

/** 全形式を否定するために必要な最大prefix長 */
const MAX_FORMAT_MIN_PREFIX_BYTES = Math.max(...Object.values(FORMAT_MIN_PREFIX_BYTES));

/**
 * ftyp探索の上限バイト数。
 * ISOBMFFのFileTypeBoxは先頭box (offset 4) に置かれる。
 * バッファ全体を線形走査すると入力長に比例したコストが発生するため有界化する。
 * offset 4限定にせず余裕を持たせるのは、非厳密なファイルの取りこぼしを避けるため。
 */
const FTYP_SEARCH_LIMIT_BYTES = 256;

/** Safetensorsのlength prefixのbyte数 */
const SAFETENSORS_HEADER_LENGTH_BYTES = 8;
/** Safetensors先頭length prefixを含むmetadata head予算 */
const SAFETENSORS_METADATA_HEAD_BUDGET_BYTES = 16 * 1024 * 1024;
/** Safetensors header本体へ割り当てられる最大byte数 */
const SAFETENSORS_MAX_HEADER_BYTES = SAFETENSORS_METADATA_HEAD_BUDGET_BYTES - SAFETENSORS_HEADER_LENGTH_BYTES;

/** 非PNG parserの内部状態 */
const PARSER_STATE_RESOLVED = 'resolved';
const PARSER_STATE_EMPTY_CONFIRMED = 'empty-confirmed';
const PARSER_STATE_RESOURCE_LIMIT = 'resource-limit';
const PARSER_STATE_UNRESOLVED = 'unresolved';
const PARSER_STATE_INVALID = 'invalid';
const PARSER_STATE_UNSUPPORTED_FORMAT = 'unsupported-format';
const WEBP_MAX_CONTAINER_SIZE_BYTES = 256 * 1024 * 1024;

/** 形式別metadata head budget */
const JPEG_METADATA_HEAD_BUDGET_BYTES = 256 * 1024;
const AVIF_METADATA_HEAD_BUDGET_BYTES = 256 * 1024;
const EXIF_MAX_DIRECTORY_COUNT = 32;
const EXIF_MAX_ENTRY_COUNT = 4096;
const EXIF_MAX_VALUE_BYTES = 8 * 1024 * 1024;

/** JSON開始文字 '{' */
const JSON_OBJECT_START_BYTE = 0x7B;

/** PNG／非PNGの二値判定結果 */
const PNG_PREFIX_PNG = 'png';
const PNG_PREFIX_NOT_PNG = 'not-png';
const PNG_PREFIX_UNDETERMINED = 'undetermined';

/**
 * 先頭バイト列がPNGかどうかだけを三値で判定する。
 * 取得層が上限適用の可否を決めるための二値判定に使用し、形式確定には使わない。
 * @param {ArrayBuffer|Uint8Array} buffer - 先頭バイト列
 * @returns {string} - 'png' | 'not-png' | 'undetermined'
 */
function classifyPngPrefix(buffer) {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const available = Math.min(view.length, PNG_SIGNATURE.length);

  for (let i = 0; i < available; i++) {
    if (view[i] !== PNG_SIGNATURE[i]) return PNG_PREFIX_NOT_PNG;
  }
  // ここまで一致。全8 bytesを確認できていなければ確定できない。
  return view.length >= PNG_SIGNATURE.length ? PNG_PREFIX_PNG : PNG_PREFIX_UNDETERMINED;
}

/**
 * 画像形式を判定し、判定不能かどうかも返す。
 * 「非対応形式」と「prefix不足で未判定」を呼び出し側が区別できるようにする。
 * @param {ArrayBuffer|Uint8Array} buffer - 画像バイナリデータ
 * @returns {{format: string|null, undetermined: boolean}}
 */
function detectImageFormatDetailed(buffer) {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  // PNG: 8 bytes完全一致のみを認める
  const pngPrefix = classifyPngPrefix(view);
  if (pngPrefix === PNG_PREFIX_PNG) {
    return { format: 'png', undetermined: false };
  }

  // JPEG: FF D8 FF
  if (view.length >= FORMAT_MIN_PREFIX_BYTES.jpeg &&
    view[0] === 0xFF && view[1] === 0xD8 && view[2] === 0xFF) {
    return { format: 'jpeg', undetermined: false };
  }

  // WebP: RIFF ... WEBP
  if (view.length >= FORMAT_MIN_PREFIX_BYTES.webp &&
    view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46 &&
    view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50) {
    return { format: 'webp', undetermined: false };
  }

  // AVIF: 先頭box内の ftyp と brand を有界探索する
  if (view.length >= FORMAT_MIN_PREFIX_BYTES.avif) {
    const window = view.subarray(0, Math.min(view.length, FTYP_SEARCH_LIMIT_BYTES));
    const ftypIndex = findSequence(window, FTYP_MARKER);
    if (ftypIndex !== -1 && ftypIndex + 8 <= view.length) {
      const brand = view.subarray(ftypIndex + 4, ftypIndex + 8);
      const brandStr = String.fromCharCode(...brand);
      if (brandStr === 'avif' || brandStr === 'avis') {
        return { format: 'avif', undetermined: false };
      }
    }
  }

  // Safetensors: 先頭8 bytesがheaderサイズのLE Uint64で、直後がJSONの '{'
  if (view.length >= FORMAT_MIN_PREFIX_BYTES.safetensors) {
    const headerSize = getUint64LE(view, 0);
    if (Number.isSafeInteger(headerSize) && headerSize > 0 &&
      view[8] === JSON_OBJECT_START_BYTE) {
      return { format: 'safetensors', undetermined: false };
    }
  }

  // 未一致。prefixが不足していれば否定も確定できない。
  const undetermined = pngPrefix === PNG_PREFIX_UNDETERMINED ||
    view.length < MAX_FORMAT_MIN_PREFIX_BYTES;
  return { format: null, undetermined };
}

/**
 * 画像形式を判定
 * @param {ArrayBuffer|Uint8Array} buffer - 画像バイナリデータ
 * @returns {string|null} - 'png', 'jpeg', 'webp', 'avif', 'safetensors', または null
 */
function detectImageFormat(buffer) {
  return detectImageFormatDetailed(buffer).format;
}

/**
 * Little Endian Uint64 を読み取り (数値精度に注意)
 */
function getUint64LE(view, offset) {
  // JavaScriptの整数精度(53bit)に収まる範囲のみ対応
  // ビット演算(<<)は32bit符号付きとして扱われるため、大きな値で正しく動作させるために乗算と加算を使用
  const b0 = view[offset];
  const b1 = view[offset + 1];
  const b2 = view[offset + 2];
  const b3 = view[offset + 3];
  const b4 = view[offset + 4];
  const b5 = view[offset + 5];
  const b6 = view[offset + 6];
  const b7 = view[offset + 7];

  const low = b0 + (b1 * 256) + (b2 * 65536) + (b3 * 16777216);
  const high = b4 + (b5 * 256) + (b6 * 65536) + (b7 * 16777216);
  return low + (high * 4294967296);
}

/**
 * バイト配列内でシーケンスを検索
 * @param {Uint8Array} array - 検索対象配列
 * @param {number[]} sequence - 検索するシーケンス
 * @returns {number} - 見つかった位置、見つからない場合は -1
 */
function findSequence(array, sequence) {
  for (let i = 0; i <= array.length - sequence.length; i++) {
    let found = true;
    for (let j = 0; j < sequence.length; j++) {
      if (array[i + j] !== sequence[j]) {
        found = false;
        break;
      }
    }
    if (found) return i;
  }
  return -1;
}

/**
 * PNGのテキスト系チャンク（tEXt/iTXt）をパースして結果を格納するヘルパー
 * @param {string} type - チャンク型 ('tEXt' or 'iTXt')
 * @param {Uint8Array} chunkData - チャンクのデータ部
 * @param {Object} metadata - 格納先オブジェクト
 */
function parsePngTextChunk(type, chunkData, metadata) {
  if (type === 'tEXt') {
    const nullIndex = chunkData.indexOf(0);
    if (nullIndex !== -1) {
      const keyword = new TextDecoder('utf-8').decode(chunkData.slice(0, nullIndex));
      const text = new TextDecoder('utf-8').decode(chunkData.slice(nullIndex + 1));
      metadata[keyword] = text;
    }
  } else if (type === 'iTXt') {
    let pos = 0;
    const keywordEnd = chunkData.indexOf(0, pos);
    if (keywordEnd === -1) return;

    const keyword = new TextDecoder('utf-8').decode(chunkData.slice(pos, keywordEnd));
    pos = keywordEnd + 1;

    const compressionFlag = chunkData[pos];
    pos += 2; // compressionFlag(1) + compressionMethod(1)

    const langEnd = chunkData.indexOf(0, pos);
    if (langEnd === -1) return;
    pos = langEnd + 1;

    const transEnd = chunkData.indexOf(0, pos);
    if (transEnd === -1) return;
    pos = transEnd + 1;

    if (compressionFlag === 0) {
      const text = new TextDecoder('utf-8').decode(chunkData.slice(pos));
      metadata[keyword] = text;
    } else if (compressionFlag === 1) {
      // 圧縮された iTXt チャンクのデコード (HANDOVER 指示に基づく)
      try {
        if (typeof pako !== 'undefined') {
          const compressedData = chunkData.slice(pos);
          const inflated = pako.inflate(compressedData);
          const text = new TextDecoder('utf-8').decode(inflated);
          metadata[keyword] = text;
        } else {
          console.warn('[AI Meta Viewer] pako.js not loaded, cannot decompress iTXt chunk');
        }
      } catch (err) {
        console.error('[AI Meta Viewer] Failed to decompress iTXt chunk:', err);
      }
    }
  }
}

/**
 * PNG形式のメタデータを抽出
 * @param {ArrayBuffer} buffer - 画像バイナリデータ
 * @returns {Object} - 抽出されたメタデータ
 */
function extractPngMetadata(buffer) {
  const view = new Uint8Array(buffer);
  const metadata = {};

  // PNGシグネチャをスキップ (8バイト)
  let offset = 8;
  let isFirstChunkAfterIHDR = true;
  let isComfyUIStyle = false;
  let reachedIend = false;

  while (offset < view.length) {
    // チャンク長を読み取るための最低4バイトがあるか
    if (offset + 4 > view.length) break;

    // チャンク長を読み取り (Big Endian)
    const length = readUint32BE(view, offset);

    // チャンク型を読み取るための8バイトがあるかチェック
    if (offset + 8 > view.length) break;

    // 興味のあるチャンク（tEXt, iTXt）であれば再取得を指示
    const typeStr = String.fromCharCode(view[offset + 4], view[offset + 5],
      view[offset + 6], view[offset + 7]);

    // ComfyUI / Pillow の指紋チェック (IHDRの直後がピッタリ65536bytesのIDAT)
    if (typeStr !== 'IHDR') {
      if (isFirstChunkAfterIHDR) {
        if (typeStr === 'IDAT' && length === 65536) {
          isComfyUIStyle = true;
        }
        isFirstChunkAfterIHDR = false;
      }
    }

    // データが不足しているかチェック (チャンク長4 + タイプ4 + データ + CRC4)
    if (offset + 4 + 4 + length + 4 > view.length) {
      if (typeStr === 'tEXt' || typeStr === 'iTXt') {
        return setParserState(metadata, PARSER_STATE_UNRESOLVED, {
          isIncomplete: true,
          suggestedSize: offset + 4 + 4 + length + 4 - 1,
        });
      }
      if (typeStr === 'eXIf') {
        const dataStart = offset + 8;
        const availableLength = Math.max(0, Math.min(length, view.length - dataStart));
        const exifResult = extractExifPayload(view.subarray(dataStart, dataStart + availableLength), {
          declaredLength: length,
        });
        Object.assign(metadata, exifResult);
        if (Object.keys(metadata).length > 0) {
          return setParserState(metadata, PARSER_STATE_RESOLVED, { metadataPartial: true });
        }
        return setParserState(metadata, PARSER_STATE_UNRESOLVED, {
          isIncomplete: true,
          suggestedSize: offset + 4 + 4 + length + 4 - 1,
        });
      }
      // ComfyUIスタイルの画像でIDATの途中で切れた場合、ファイル末尾にメタデータがある可能性が高い
      if (isComfyUIStyle && typeStr === 'IDAT') {
        Object.assign(metadata, { isIncomplete: true, requiresTailFetch: true });
        return metadata;
      }
      // それ以外（画像データなど）なら単に終了
      break;
    }

    offset += 4;

    // チャンク型を読み取り
    const type = String.fromCharCode(view[offset], view[offset + 1],
      view[offset + 2], view[offset + 3]);
    offset += 4;

    // tEXt / iTXt チャンク処理 (共通ヘルパー呼び出し)
    if (type === 'tEXt' || type === 'iTXt') {
      const chunkData = view.slice(offset, offset + length);
      parsePngTextChunk(type, chunkData, metadata);
    } else if (type === 'eXIf') {
      const exifResult = extractExifPayload(view.subarray(offset, offset + length), {
        declaredLength: length,
      });
      Object.assign(metadata, exifResult);
      if (exifResult.parserState === PARSER_STATE_UNRESOLVED ||
          exifResult.parserState === PARSER_STATE_RESOURCE_LIMIT) {
        return setParserState(metadata, exifResult.parserState, {
          isIncomplete: true,
          parserReason: exifResult.parserReason,
        });
      }
    }

    // IENDチャンクで終了
    if (type === 'IEND') {
      reachedIend = true;
      break;
    }

    offset += length + 4; // データ + CRC
  }

  if (Object.keys(metadata).length > 0) return setParserState(metadata, PARSER_STATE_RESOLVED);
  return setParserState(metadata, reachedIend ? PARSER_STATE_EMPTY_CONFIRMED : PARSER_STATE_UNRESOLVED, {
    ...(!reachedIend ? { isIncomplete: true } : {}),
  });
}

/**
 * JPEG/AVIF形式のメタデータを抽出
 * @param {ArrayBuffer} buffer - 画像バイナリデータ
 * @returns {Object} - 抽出されたメタデータ
 */
function setParserState(metadata, state, details = {}) {
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

function readTiffUint16(view, offset, isLittleEndian) {
  if (offset < 0 || offset + 2 > view.length) return null;
  return isLittleEndian
    ? view[offset] + view[offset + 1] * 0x100
    : view[offset] * 0x100 + view[offset + 1];
}

function readTiffUint32(view, offset, isLittleEndian) {
  if (offset < 0 || offset + 4 > view.length) return null;
  return isLittleEndian
    ? view[offset] + view[offset + 1] * 0x100 + view[offset + 2] * 0x10000 + view[offset + 3] * 0x1000000
    : view[offset] * 0x1000000 + view[offset + 1] * 0x10000 + view[offset + 2] * 0x100 + view[offset + 3];
}

function getExifTypeSize(type) {
  switch (type) {
    case 1: case 2: case 6: case 7: return 1;
    case 3: case 8: return 2;
    case 4: case 9: case 11: case 13: return 4;
    case 5: case 10: case 12: return 8;
    default: return null;
  }
}

/**
 * TIFF/EXIFのIFD構造から生成情報に使われるタグだけを取得する。
 * `data` はEXIF領域の先頭prefixでもよく、未読範囲に対象値があればunresolvedを返す。
 */
function extractExifMetadata(dataValue, options = {}) {
  const data = dataValue instanceof Uint8Array
    ? dataValue
    : new Uint8Array(dataValue || 0);
  const tiffStart = Number.isSafeInteger(options.tiffStart) ? options.tiffStart : 0;
  const declaredLength = Number.isSafeInteger(options.declaredLength) && options.declaredLength >= 0
    ? options.declaredLength
    : data.length - tiffStart;
  const metadata = {};
  const incomplete = (reason, requiredEnd = null) => {
    if (Object.keys(metadata).length > 0) {
      return setParserState(metadata, PARSER_STATE_RESOLVED, {
        metadataPartial: true,
        ...(Number.isSafeInteger(requiredEnd) ? { suggestedSize: Math.max(0, requiredEnd - 1) } : {}),
      });
    }
    return setParserState(metadata, PARSER_STATE_UNRESOLVED, {
      isIncomplete: true,
      parserReason: reason,
      ...(Number.isSafeInteger(requiredEnd) ? { suggestedSize: Math.max(0, requiredEnd - 1) } : {}),
    });
  };
  const resourceLimit = reason => setParserState(metadata, PARSER_STATE_RESOURCE_LIMIT, {
    parserReason: reason,
  });
  const invalid = reason => setParserState({}, PARSER_STATE_INVALID, {
    parserReason: reason,
  });

  if (tiffStart < 0) return invalid('invalid-tiff-offset');
  if (declaredLength < 8) return invalid('tiff-header-too-short');
  if (tiffStart + 8 > data.length) {
    return incomplete('tiff-header-truncated', tiffStart + 8);
  }
  const endian = String.fromCharCode(data[tiffStart], data[tiffStart + 1]);
  if (endian !== 'II' && endian !== 'MM') return invalid('invalid-tiff-byte-order');
  const isLittleEndian = endian === 'II';
  if (readTiffUint16(data, tiffStart + 2, isLittleEndian) !== 42) {
    return invalid('invalid-tiff-magic');
  }

  const firstIfdOffset = readTiffUint32(data, tiffStart + 4, isLittleEndian);
  if (firstIfdOffset === null || firstIfdOffset < 8 || firstIfdOffset + 2 > declaredLength) {
    return invalid('invalid-first-ifd-offset');
  }
  const queue = [firstIfdOffset];
  const visited = new Set();
  let entryCountTotal = 0;
  let foundIncompleteValue = false;
  let requiredEnd = null;

  const readEntryValue = (entryOffset, type, count) => {
    const typeSize = getExifTypeSize(type);
    if (typeSize === null || !Number.isSafeInteger(count) || count < 0) {
      return { valid: false, complete: false, bytes: new Uint8Array(0), end: null };
    }
    const byteLength = typeSize * count;
    if (!Number.isSafeInteger(byteLength) || byteLength > EXIF_MAX_VALUE_BYTES) {
      return { valid: false, complete: false, bytes: new Uint8Array(0), end: null, limited: true };
    }
    const relativeOffset = byteLength <= 4
      ? entryOffset + 8 - tiffStart
      : readTiffUint32(data, entryOffset + 8, isLittleEndian);
    if (relativeOffset === null || relativeOffset < 0) {
      return { valid: false, complete: false, bytes: new Uint8Array(0), end: null };
    }
    const end = relativeOffset + byteLength;
    if (!Number.isSafeInteger(end) || end > declaredLength) {
      return { valid: false, complete: false, bytes: new Uint8Array(0), end };
    }
    const start = tiffStart + relativeOffset;
    const availableEnd = Math.min(start + byteLength, data.length);
    const bytes = start < data.length
      ? data.subarray(start, Math.max(start, availableEnd))
      : new Uint8Array(0);
    return { valid: true, complete: bytes.byteLength === byteLength, bytes, end };
  };

  while (queue.length > 0) {
    const relativeIfdOffset = queue.shift();
    if (relativeIfdOffset === 0 || visited.has(relativeIfdOffset)) continue;
    if (visited.size >= EXIF_MAX_DIRECTORY_COUNT) return resourceLimit('exif-directory-count');
    visited.add(relativeIfdOffset);

    const ifdStart = tiffStart + relativeIfdOffset;
    if (relativeIfdOffset + 2 > declaredLength) return invalid('ifd-count-outside-exif-data');
    if (ifdStart + 2 > data.length) {
      return incomplete('ifd-count-truncated', relativeIfdOffset + 2);
    }
    const entryCount = readTiffUint16(data, ifdStart, isLittleEndian);
    if (entryCount === null) return incomplete('ifd-count-truncated');
    entryCountTotal += entryCount;
    if (entryCountTotal > EXIF_MAX_ENTRY_COUNT) return resourceLimit('exif-entry-count');
    const ifdEndRelative = relativeIfdOffset + 2 + entryCount * 12 + 4;
    if (!Number.isSafeInteger(ifdEndRelative) || ifdEndRelative > declaredLength) {
      return invalid('ifd-outside-exif-data');
    }
    if (tiffStart + ifdEndRelative > data.length) {
      return incomplete('ifd-entries-truncated', ifdEndRelative);
    }

    for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
      const entryOffset = ifdStart + 2 + entryIndex * 12;
      const tag = readTiffUint16(data, entryOffset, isLittleEndian);
      const type = readTiffUint16(data, entryOffset + 2, isLittleEndian);
      const count = readTiffUint32(data, entryOffset + 4, isLittleEndian);
      if (tag === null || type === null || count === null) {
        return incomplete('ifd-entry-truncated');
      }

      if (tag === 0x010E || tag === 0x9286) {
        const value = readEntryValue(entryOffset, type, count);
        if (value.limited) return resourceLimit('exif-value-size');
        if (!value.valid) return invalid('invalid-exif-value-range');
        if (!value.complete) {
          foundIncompleteValue = true;
          requiredEnd = Math.max(requiredEnd || 0, value.end);
        }
        if (value.bytes.length > 0) {
          if (tag === 0x010E) {
            const description = new TextDecoder('utf-8').decode(value.bytes).replace(/\0+$/, '');
            if (description) metadata.Description = description;
          } else {
            const comment = parseExifUserComment(value.bytes, isLittleEndian);
            if (comment) metadata.parameters = comment;
          }
        }
      }

      // Exif/GPS/Interop/SubIFD pointers are valid directory links; never infer
      // tags by searching arbitrary bytes inside a value or thumbnail.
      if ([0x8769, 0x8825, 0xA005, 0x014A].includes(tag) && (type === 4 || type === 13)) {
        if (count > EXIF_MAX_DIRECTORY_COUNT) return resourceLimit('exif-ifd-pointer-count');
        const pointers = readEntryValue(entryOffset, type, count);
        if (pointers.limited) return resourceLimit('exif-ifd-pointer-size');
        if (!pointers.valid) return invalid('invalid-ifd-pointer-range');
        if (!pointers.complete) {
          return incomplete('ifd-pointer-truncated', pointers.end);
        }
        for (let pointerIndex = 0; pointerIndex < count; pointerIndex += 1) {
          const pointerOffset = readTiffUint32(pointers.bytes, pointerIndex * 4, isLittleEndian);
          if (pointerOffset === null) return incomplete('ifd-pointer-truncated');
          if (pointerOffset !== 0) queue.push(pointerOffset);
        }
      }
    }

    const nextIfdOffset = readTiffUint32(data, ifdStart + 2 + entryCount * 12, isLittleEndian);
    if (nextIfdOffset === null) return incomplete('next-ifd-pointer-truncated');
    if (nextIfdOffset !== 0) queue.push(nextIfdOffset);
  }

  if (foundIncompleteValue) {
    return incomplete('exif-value-truncated', requiredEnd);
  }
  return setParserState(metadata,
    Object.keys(metadata).length > 0 ? PARSER_STATE_RESOLVED : PARSER_STATE_EMPTY_CONFIRMED);
}

function extractExifPayload(dataValue, options = {}) {
  const data = dataValue instanceof Uint8Array
    ? dataValue
    : new Uint8Array(dataValue || 0);
  const declaredLength = Number.isSafeInteger(options.declaredLength) && options.declaredLength >= 0
    ? options.declaredLength
    : data.byteLength;
  const allowExifPrefix = options.allowExifPrefix === true;
  let tiffStart = 0;
  if (allowExifPrefix && data.length >= 6 &&
      data[0] === 0x45 && data[1] === 0x78 && data[2] === 0x69 &&
      data[3] === 0x66 && data[4] === 0 && data[5] === 0) {
    tiffStart = 6;
  }
  const parsed = extractExifMetadata(data, {
    tiffStart,
    declaredLength: Math.max(0, declaredLength - tiffStart),
  });
  if (!Number.isSafeInteger(parsed.suggestedSize)) return parsed;
  return setParserState(parsed, parsed.parserState, {
    ...(parsed.isIncomplete ? { isIncomplete: true } : {}),
    ...(parsed.metadataPartial ? { metadataPartial: true } : {}),
    ...(parsed.parserReason ? { parserReason: parsed.parserReason } : {}),
    suggestedSize: tiffStart + parsed.suggestedSize,
  });
}

function scanJpegMarkers(view) {
  if (view.length < 3 || view[0] !== 0xFF || view[1] !== 0xD8) {
    return { reachedSos: false, complete: false, metadata: {}, exifIncomplete: false };
  }

  const metadata = {};
  let exifIncomplete = false;
  let exifInvalid = false;
  let metadataPartial = false;
  let suggestedSize = null;
  let offset = 2;
  while (offset < view.length) {
    if (view[offset] !== 0xFF) return { reachedSos: false, complete: false, metadata, exifIncomplete };
    while (offset < view.length && view[offset] === 0xFF) offset++;
    if (offset >= view.length) return { reachedSos: false, complete: false, metadata, exifIncomplete };

    const marker = view[offset++];
    if (marker === 0xDA) return { reachedSos: true, complete: true, metadata, exifIncomplete, exifInvalid, metadataPartial };
    if (marker === 0xD9) return { reachedSos: false, complete: true, metadata, exifIncomplete, exifInvalid, metadataPartial };
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue;

    if (offset + 2 > view.length) return { reachedSos: false, complete: false, metadata, exifIncomplete, metadataPartial };
    const segmentLength = (view[offset] << 8) | view[offset + 1];
    if (segmentLength < 2) return { reachedSos: false, complete: false, metadata, exifIncomplete: true };
    if (offset + segmentLength > view.length) {
      const payloadStart = offset + 2;
      if (marker === 0xE1 && payloadStart + 6 <= view.length &&
          view[payloadStart] === 0x45 && view[payloadStart + 1] === 0x78 &&
          view[payloadStart + 2] === 0x69 && view[payloadStart + 3] === 0x66 &&
          view[payloadStart + 4] === 0 && view[payloadStart + 5] === 0) {
        exifIncomplete = true;
        suggestedSize = offset + segmentLength - 1;
      }
      return { reachedSos: false, complete: false, metadata, exifIncomplete, metadataPartial, suggestedSize };
    }
    const payloadStart = offset + 2;
    const payloadEnd = offset + segmentLength;
    if (marker === 0xE1 && payloadStart + 6 <= payloadEnd &&
        view[payloadStart] === 0x45 && view[payloadStart + 1] === 0x78 &&
        view[payloadStart + 2] === 0x69 && view[payloadStart + 3] === 0x66 &&
        view[payloadStart + 4] === 0 && view[payloadStart + 5] === 0) {
      const parsed = extractExifPayload(view.subarray(payloadStart, payloadEnd), {
        allowExifPrefix: true,
        declaredLength: payloadEnd - payloadStart,
      });
      Object.assign(metadata, parsed);
      if (parsed.parserState === PARSER_STATE_UNRESOLVED || parsed.parserState === PARSER_STATE_RESOURCE_LIMIT) {
        exifIncomplete = true;
      }
      if (parsed.parserState === PARSER_STATE_INVALID) exifInvalid = true;
      metadataPartial ||= parsed.metadataPartial === true;
      if (Number.isSafeInteger(parsed.suggestedSize)) {
        suggestedSize = Math.max(suggestedSize || 0, payloadStart + parsed.suggestedSize);
      }
    }
    offset += segmentLength;
  }
  return { reachedSos: false, complete: false, metadata, exifIncomplete, metadataPartial, suggestedSize };
}

function extractJpegMetadata(buffer, options = {}) {
  const markerResult = scanJpegMarkers(new Uint8Array(buffer));
  const metadata = markerResult.metadata;
  if (Object.keys(metadata).length > 0) {
    return setParserState(metadata, PARSER_STATE_RESOLVED, {
      ...(markerResult.metadataPartial || markerResult.exifIncomplete ? { metadataPartial: true } : {}),
      ...(Number.isSafeInteger(markerResult.suggestedSize) ? { suggestedSize: markerResult.suggestedSize } : {}),
    });
  }
  if (markerResult.exifIncomplete || (!markerResult.reachedSos && !markerResult.complete)) {
    return setParserState(metadata, PARSER_STATE_UNRESOLVED, {
      isIncomplete: true,
      suggestedSize: Number.isSafeInteger(markerResult.suggestedSize)
        ? markerResult.suggestedSize
        : JPEG_METADATA_HEAD_BUDGET_BYTES - 1,
    });
  }
  if (markerResult.exifInvalid) {
    return setParserState(metadata, PARSER_STATE_INVALID, { parserReason: 'invalid-exif' });
  }
  if (markerResult.reachedSos || markerResult.complete) {
    return setParserState(metadata, PARSER_STATE_EMPTY_CONFIRMED);
  }
  return setParserState({}, PARSER_STATE_UNRESOLVED, {
    isIncomplete: true,
    suggestedSize: JPEG_METADATA_HEAD_BUDGET_BYTES - 1,
  });
}

/**
 * WebP形式のメタデータを抽出
 * @param {ArrayBuffer} buffer - 画像バイナリデータ
 * @returns {Object} - 抽出されたメタデータ
 */
function readUint32LE(view, offset) {
  if (offset < 0 || offset + 4 > view.length) return null;
  return view[offset] + view[offset + 1] * 0x100 +
    view[offset + 2] * 0x10000 + view[offset + 3] * 0x1000000;
}

function getWebpChunkHeader(view, offset, totalSize) {
  if (offset < 12 || offset + 8 > view.length) return null;
  const size = readUint32LE(view, offset + 4);
  const dataOffset = offset + 8;
  const nextOffset = dataOffset + size + (size & 1);
  if (size === null || !Number.isSafeInteger(nextOffset) || nextOffset > totalSize) return null;
  return {
    type: String.fromCharCode(view[offset], view[offset + 1], view[offset + 2], view[offset + 3]),
    size,
    dataOffset,
    nextOffset,
  };
}

function extractWebpMetadata(buffer, options = {}) {
  const view = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (view.length < 12) {
    return setParserState({}, PARSER_STATE_UNRESOLVED, { isIncomplete: true, suggestedSize: 11 });
  }
  if (view[0] !== 0x52 || view[1] !== 0x49 || view[2] !== 0x46 || view[3] !== 0x46 ||
      view[8] !== 0x57 || view[9] !== 0x45 || view[10] !== 0x42 || view[11] !== 0x50) {
    return setParserState({}, PARSER_STATE_UNSUPPORTED_FORMAT);
  }

  const declaredTotalSize = readUint32LE(view, 4) + 8;
  if (!Number.isSafeInteger(declaredTotalSize) || declaredTotalSize < 12) {
    return setParserState({}, PARSER_STATE_UNRESOLVED, { isIncomplete: true });
  }
  const maxContainerBytes = Number.isSafeInteger(options.maxContainerBytes) && options.maxContainerBytes >= 12
    ? Math.min(options.maxContainerBytes, WEBP_MAX_CONTAINER_SIZE_BYTES)
    : WEBP_MAX_CONTAINER_SIZE_BYTES;
  if (declaredTotalSize > maxContainerBytes || view.length > maxContainerBytes) {
    return setParserState({}, PARSER_STATE_RESOURCE_LIMIT, { parserReason: 'webp-container-size' });
  }
  const availableEnd = Math.min(view.length, maxContainerBytes);
  // A malformed RIFF length can be smaller than chunks actually present in the
  // supplied representation. Scan the available bounded extent and validate
  // each chunk against it instead of silently dropping those chunks.
  const totalSize = Math.max(declaredTotalSize, availableEnd);
  const metadata = {};
  let offset = 12;
  let pendingExif = false;
  let invalidExif = false;

  const unresolved = (requiredEnd = null, reason = null) => {
    const found = Object.keys(metadata).length > 0;
    return setParserState(metadata, found ? PARSER_STATE_RESOLVED : PARSER_STATE_UNRESOLVED, {
      ...(!found ? { isIncomplete: true } : { metadataPartial: true }),
      ...(reason ? { parserReason: reason } : {}),
      ...(Number.isSafeInteger(requiredEnd) ? { suggestedSize: Math.max(0, requiredEnd - 1) } : {}),
    });
  };

  while (offset < totalSize) {
    if (offset + 8 > availableEnd) return unresolved(offset + 8, 'webp-chunk-header-truncated');
    const chunk = getWebpChunkHeader(view, offset, totalSize);
    if (!chunk) return unresolved(null, 'webp-chunk-length-invalid');

    const chunkDataEnd = chunk.dataOffset + chunk.size;
    const chunkComplete = chunkDataEnd <= availableEnd && chunk.nextOffset <= availableEnd;
    if (chunk.type === 'EXIF') {
      const payload = view.subarray(chunk.dataOffset, Math.min(chunkDataEnd, availableEnd));
      const parsed = extractExifPayload(payload, {
        allowExifPrefix: true,
        declaredLength: chunk.size,
      });
      Object.assign(metadata, parsed);
      if (parsed.parserState === PARSER_STATE_UNRESOLVED || parsed.parserState === PARSER_STATE_RESOURCE_LIMIT ||
          parsed.metadataPartial === true) {
        pendingExif = true;
      }
      if (parsed.parserState === PARSER_STATE_INVALID) invalidExif = true;
      if (parsed.parserState === PARSER_STATE_UNRESOLVED && Number.isSafeInteger(parsed.suggestedSize)) {
        return unresolved(chunk.dataOffset + parsed.suggestedSize + 1, parsed.parserReason);
      }
      if (parsed.metadataPartial === true && Number.isSafeInteger(parsed.suggestedSize)) {
        return setParserState(metadata, PARSER_STATE_RESOLVED, {
          metadataPartial: true,
          suggestedSize: chunk.dataOffset + parsed.suggestedSize,
        });
      }
    } else if (chunk.type === 'XMP ') {
      if (!chunkComplete) {
        const payload = view.subarray(chunk.dataOffset, Math.min(chunkDataEnd, availableEnd));
        const parsed = parseXmpMetadata(new TextDecoder('utf-8').decode(payload));
        Object.assign(metadata, parsed);
        return unresolved(chunk.nextOffset, 'webp-xmp-chunk-truncated');
      }
      const xmpText = new TextDecoder('utf-8').decode(view.subarray(chunk.dataOffset, chunkDataEnd));
      Object.assign(metadata, parseXmpMetadata(xmpText));
    }

    if (!chunkComplete) {
      // Image payloads are skipped by declared chunk length. A later metadata
      // chunk remains possible, so advance to its header without buffering VP8.
      return unresolved(chunk.nextOffset + 8, pendingExif
        ? 'webp-exif-incomplete'
        : 'webp-chunk-payload-skipped');
    }
    offset = chunk.nextOffset;
  }

  if (offset !== totalSize || view.length < totalSize || pendingExif || options.inputComplete === false) {
    return unresolved(totalSize, pendingExif ? 'webp-exif-incomplete' : 'webp-container-incomplete');
  }
  if (invalidExif && Object.keys(metadata).length === 0) {
    return setParserState(metadata, PARSER_STATE_INVALID, { parserReason: 'invalid-exif' });
  }
  return setParserState(metadata,
    Object.keys(metadata).length > 0 ? PARSER_STATE_RESOLVED : PARSER_STATE_EMPTY_CONFIRMED);
}

function createWebpMetadataStreamScanner(options = {}) {
  const maxMetadataBytes = Number.isSafeInteger(options.maxMetadataBytes) && options.maxMetadataBytes > 0
    ? Math.min(options.maxMetadataBytes, 256 * 1024)
    : 64 * 1024;
  const maxContainerBytes = Number.isSafeInteger(options.maxContainerBytes) && options.maxContainerBytes >= 12
    ? Math.min(options.maxContainerBytes, WEBP_MAX_CONTAINER_SIZE_BYTES)
    : WEBP_MAX_CONTAINER_SIZE_BYTES;
  const riffHeader = new Uint8Array(12);
  const chunkHeader = new Uint8Array(8);
  let riffHeaderLength = 0;
  let chunkHeaderLength = 0;
  let position = 0;
  let totalSize = null;
  let nextChunkOffset = 12;
  let activeChunk = null;
  let capture = null;
  let metadata = {};
  let state = PARSER_STATE_UNRESOLVED;
  let invalid = false;
  let complete = false;
  let incompleteMetadataChunk = false;
  let invalidMetadataChunk = false;
  let metadataPartial = false;
  let resourceLimited = false;

  const parseCapture = (chunkComplete) => {
    if (!capture || capture.parsed) return;
    const payload = capture.bytes.subarray(0, capture.length);
    let parsed;
    if (capture.type === 'EXIF') {
      parsed = extractExifPayload(payload, {
        allowExifPrefix: true,
        declaredLength: capture.chunkSize,
      });
    } else {
      const xmpText = new TextDecoder('utf-8').decode(payload);
      parsed = parseXmpMetadata(xmpText);
      if (!chunkComplete && Object.keys(parsed).length > 0) metadataPartial = true;
    }
    capture.parsed = true;
    const hasMetadata = Object.keys(parsed).length > 0;
    if (hasMetadata) {
      Object.assign(metadata, parsed);
      metadataPartial ||= parsed.metadataPartial === true || !chunkComplete;
      state = PARSER_STATE_RESOLVED;
    } else if (parsed.parserState === PARSER_STATE_UNRESOLVED ||
        parsed.parserState === PARSER_STATE_RESOURCE_LIMIT ||
        (!chunkComplete && capture.type === 'XMP ')) {
      incompleteMetadataChunk = true;
    } else if (parsed.parserState === PARSER_STATE_INVALID) {
      invalidMetadataChunk = true;
    }
  };

  const snapshot = () => ({
    state: resourceLimited ? PARSER_STATE_RESOURCE_LIMIT : invalid ? PARSER_STATE_UNRESOLVED : state,
    metadata: { ...metadata },
    complete,
    invalid,
    incompleteMetadataChunk,
    invalidMetadataChunk,
    metadataPartial,
    bytesRead: position,
  });

  const push = (value) => {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let index = 0;
    while (index < bytes.length) {
      const absoluteOffset = position + index;
      if (riffHeaderLength < riffHeader.length) {
        const amount = Math.min(riffHeader.length - riffHeaderLength, bytes.length - index);
        riffHeader.set(bytes.subarray(index, index + amount), riffHeaderLength);
        riffHeaderLength += amount;
        index += amount;
        if (riffHeaderLength < riffHeader.length) continue;
        if (riffHeader[0] !== 0x52 || riffHeader[1] !== 0x49 || riffHeader[2] !== 0x46 || riffHeader[3] !== 0x46 ||
            riffHeader[8] !== 0x57 || riffHeader[9] !== 0x45 || riffHeader[10] !== 0x42 || riffHeader[11] !== 0x50) {
          invalid = true;
          state = PARSER_STATE_UNSUPPORTED_FORMAT;
          break;
        }
        totalSize = readUint32LE(riffHeader, 4) + 8;
        if (!Number.isSafeInteger(totalSize) || totalSize < 12) {
          invalid = true;
          state = PARSER_STATE_UNRESOLVED;
          break;
        }
        if (totalSize > maxContainerBytes) {
          resourceLimited = true;
          state = PARSER_STATE_RESOURCE_LIMIT;
          break;
        }
        continue;
      }

      if (invalid || resourceLimited || complete || absoluteOffset >= maxContainerBytes) {
        if (absoluteOffset >= maxContainerBytes) {
          resourceLimited = true;
          state = PARSER_STATE_RESOURCE_LIMIT;
        }
        break;
      }
      if (activeChunk) {
        const payloadOffset = absoluteOffset - activeChunk.dataOffset;
        const remaining = activeChunk.size - payloadOffset;
        const amount = Math.min(bytes.length - index, remaining);
        if (capture && payloadOffset < capture.bytes.length && amount > 0) {
          const copyLength = Math.min(amount, capture.bytes.length - payloadOffset);
          capture.bytes.set(bytes.subarray(index, index + copyLength), payloadOffset);
          capture.length = Math.max(capture.length, payloadOffset + copyLength);
          if (capture.length === capture.bytes.length && payloadOffset + amount < activeChunk.size) {
            parseCapture(false);
          }
        }
        index += amount;
        if (payloadOffset + amount >= activeChunk.size) {
          if (capture && !capture.parsed) parseCapture(true);
          nextChunkOffset = activeChunk.nextOffset;
          activeChunk = null;
          capture = null;
        }
        continue;
      }

      if (absoluteOffset < nextChunkOffset) {
        index += Math.min(bytes.length - index, nextChunkOffset - absoluteOffset);
        continue;
      }

      const amount = Math.min(chunkHeader.length - chunkHeaderLength, bytes.length - index);
      chunkHeader.set(bytes.subarray(index, index + amount), chunkHeaderLength);
      chunkHeaderLength += amount;
      index += amount;
      if (chunkHeaderLength < chunkHeader.length) continue;

      const type = String.fromCharCode(chunkHeader[0], chunkHeader[1], chunkHeader[2], chunkHeader[3]);
      const size = readUint32LE(chunkHeader, 4);
      const dataOffset = nextChunkOffset + 8;
      const nextOffset = dataOffset + size + (size & 1);
      chunkHeaderLength = 0;
      if (size === null || !Number.isSafeInteger(nextOffset) || nextOffset < dataOffset) {
        invalid = true;
        state = PARSER_STATE_UNRESOLVED;
        break;
      }
      if (nextOffset > maxContainerBytes) {
        resourceLimited = true;
        state = PARSER_STATE_RESOURCE_LIMIT;
        break;
      }
      // A too-small RIFF length must not hide chunks present in the supplied
      // representation. Chunk boundaries remain the authority for the scan.
      if (nextOffset > totalSize) totalSize = nextOffset;
      activeChunk = { type, size, dataOffset, nextOffset };
      if (type === 'EXIF' || type === 'XMP ') {
        capture = {
          type,
          chunkSize: size,
          bytes: new Uint8Array(Math.min(size, maxMetadataBytes)),
          length: 0,
          parsed: false,
        };
      } else {
        capture = null;
      }
      if (size === 0) {
        if (capture && !capture.parsed) parseCapture(true);
        nextChunkOffset = nextOffset;
        activeChunk = null;
        capture = null;
      }
    }

    position += bytes.length;
    return snapshot();
  };

  const finish = (finishOptions = {}) => {
    if (finishOptions.inputComplete === false) {
      if (Object.keys(metadata).length > 0) {
        state = PARSER_STATE_RESOLVED;
        metadataPartial = true;
      } else {
        state = PARSER_STATE_UNRESOLVED;
      }
      return snapshot();
    }
    if (!invalid && !resourceLimited && totalSize !== null && position >= totalSize &&
        nextChunkOffset === totalSize && !activeChunk && chunkHeaderLength === 0) {
      complete = true;
      if (state !== PARSER_STATE_RESOLVED) {
        state = incompleteMetadataChunk
          ? PARSER_STATE_UNRESOLVED
          : invalidMetadataChunk
            ? PARSER_STATE_INVALID
            : PARSER_STATE_EMPTY_CONFIRMED;
      }
    } else if (!complete) {
      state = PARSER_STATE_UNRESOLVED;
    }
    return snapshot();
  };

  return { push, finish, snapshot };
}

/**
 * AVIF形式のメタデータを抽出
 * @param {ArrayBuffer} buffer - 画像バイナリデータ
 * @returns {Object} - 抽出されたメタデータ
 */
function readUint32BE(view, offset) {
  return view[offset] * 16777216 + view[offset + 1] * 65536 +
    view[offset + 2] * 256 + view[offset + 3];
}

function readAvifBox(view, offset, boundary) {
  if (offset + 8 > boundary || offset + 8 > view.length) return null;
  const size32 = readUint32BE(view, offset);
  const type = String.fromCharCode(view[offset + 4], view[offset + 5], view[offset + 6], view[offset + 7]);
  let headerSize = 8;
  let size = size32;
  if (size32 === 1) {
    if (offset + 16 > boundary || offset + 16 > view.length) return null;
    const high = readUint32BE(view, offset + 8);
    const low = readUint32BE(view, offset + 12);
    if (high !== 0) return { invalid: true, type, offset };
    size = low;
    headerSize = 16;
  } else if (size32 === 0) {
    size = boundary - offset;
  }
  const end = offset + size;
  if (!Number.isSafeInteger(end) || size < headerSize) {
    return { invalid: true, type, offset, end };
  }
  return {
    type,
    offset,
    headerSize,
    dataStart: offset + headerSize,
    end,
    size,
    outOfBounds: end > boundary,
  };
}

function readAvifVariableUInt(view, offset, size) {
  if (size === 0) return 0;
  if (size < 0 || size > 8 || offset < 0 || offset + size > view.length) return null;
  let value = 0;
  for (let index = 0; index < size; index += 1) {
    value = value * 256 + view[offset + index];
    if (!Number.isSafeInteger(value)) return null;
  }
  return value;
}

function parseAvifItemInfo(view, box) {
  const data = box.dataStart;
  if (data + 5 > box.end) return { complete: false, exifIds: [] };
  const version = view[data];
  if (version > 2) return { complete: false, exifIds: [] };
  const countSize = version === 0 ? 2 : 4;
  if (data + 4 + countSize > box.end) return { complete: false, exifIds: [] };
  const count = countSize === 2
    ? view[data + 4] * 256 + view[data + 5]
    : readUint32BE(view, data + 4);
  if (!Number.isSafeInteger(count) || count > EXIF_MAX_DIRECTORY_COUNT * 64) return { complete: false, exifIds: [] };
  let offset = data + 4 + countSize;
  const exifIds = [];
  for (let index = 0; index < count; index += 1) {
    const entry = readAvifBox(view, offset, box.end);
    if (!entry || entry.invalid || entry.end > box.end) return { complete: false, exifIds };
    const entryVersion = view[entry.dataStart];
    let itemId;
    let itemTypeOffset;
    if (entryVersion === 2) {
      itemId = entry.dataStart + 6 <= entry.end
        ? view[entry.dataStart + 4] * 256 + view[entry.dataStart + 5]
        : null;
      itemTypeOffset = entry.dataStart + 8;
    } else if (entryVersion === 3) {
      itemId = entry.dataStart + 8 <= entry.end
        ? readUint32BE(view, entry.dataStart + 4)
        : null;
      itemTypeOffset = entry.dataStart + 10;
    } else {
      return { complete: false, exifIds };
    }
    if (itemId === null || itemId === undefined || itemTypeOffset + 4 > entry.end) {
      return { complete: false, exifIds };
    }
    if (String.fromCharCode(view[itemTypeOffset], view[itemTypeOffset + 1],
      view[itemTypeOffset + 2], view[itemTypeOffset + 3]) === 'Exif') {
      exifIds.push(itemId);
    }
    offset = entry.end;
  }
  return { complete: true, exifIds };
}

function parseAvifItemLocations(view, box) {
  const data = box.dataStart;
  if (data + 8 > box.end) return { complete: false, items: new Map() };
  const version = view[data];
  if (version > 2) return { complete: false, items: new Map() };
  const offsetSize = view[data + 4] >> 4;
  const lengthSize = view[data + 4] & 0x0F;
  const baseOffsetSize = view[data + 5] >> 4;
  const indexSize = version === 1 || version === 2 ? view[data + 5] & 0x0F : 0;
  if ([offsetSize, lengthSize, baseOffsetSize, indexSize].some(size => size > 8)) {
    return { complete: false, items: new Map() };
  }
  let offset = data + 6;
  const itemCountSize = version < 2 ? 2 : 4;
  if (offset + itemCountSize > box.end) return { complete: false, items: new Map() };
  const itemCount = itemCountSize === 2
    ? view[offset] * 256 + view[offset + 1]
    : readUint32BE(view, offset);
  offset += itemCountSize;
  if (itemCount === null || itemCount > EXIF_MAX_DIRECTORY_COUNT * 64) {
    return { complete: false, items: new Map() };
  }

  const items = new Map();
  for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
    const idSize = version < 2 ? 2 : 4;
    if (offset + idSize + (version === 1 || version === 2 ? 2 : 0) + 2 + baseOffsetSize + 2 > box.end) {
      return { complete: false, items };
    }
    const itemId = readAvifVariableUInt(view, offset, idSize);
    offset += idSize;
    let constructionMethod = 0;
    if (version === 1 || version === 2) {
      constructionMethod = readAvifVariableUInt(view, offset, 2) & 0x0F;
      offset += 2;
    }
    const dataReferenceIndex = readAvifVariableUInt(view, offset, 2);
    offset += 2;
    const baseOffset = readAvifVariableUInt(view, offset, baseOffsetSize);
    offset += baseOffsetSize;
    const extentCount = readAvifVariableUInt(view, offset, 2);
    offset += 2;
    if (itemId === null || dataReferenceIndex === null || baseOffset === null ||
        extentCount === null || extentCount > EXIF_MAX_DIRECTORY_COUNT * 64) {
      return { complete: false, items };
    }
    const extents = [];
    for (let extentIndex = 0; extentIndex < extentCount; extentIndex += 1) {
      if ((version === 1 || version === 2) && indexSize > 0) {
        const ignoredIndex = readAvifVariableUInt(view, offset, indexSize);
        if (ignoredIndex === null) return { complete: false, items };
        offset += indexSize;
      }
      const extentOffset = readAvifVariableUInt(view, offset, offsetSize);
      offset += offsetSize;
      const extentLength = readAvifVariableUInt(view, offset, lengthSize);
      offset += lengthSize;
      if (extentOffset === null || extentLength === null) return { complete: false, items };
      extents.push({
        offset: baseOffset + extentOffset,
        length: extentLength,
        constructionMethod,
        dataReferenceIndex,
      });
    }
    items.set(itemId, extents);
  }
  return { complete: true, items };
}

function extractAvifExifFromMetaBox(view, metaBox) {
  const metadata = {};
  let metadataPartial = false;
  const childStart = metaBox.dataStart + 4; // FullBox version and flags
  if (childStart > metaBox.end || metaBox.dataStart + 4 > view.length) {
    return setParserState(metadata, PARSER_STATE_UNRESOLVED, { isIncomplete: true });
  }
  let iinf = null;
  let iloc = null;
  let idat = null;
  let offset = childStart;
  while (offset < metaBox.end) {
    const child = readAvifBox(view, offset, metaBox.end);
    if (!child || child.invalid || child.end > metaBox.end) {
      return setParserState(metadata, PARSER_STATE_UNRESOLVED, { isIncomplete: true });
    }
    if (child.type === 'iinf') iinf = child;
    else if (child.type === 'iloc') iloc = child;
    else if (child.type === 'idat') idat = child;
    offset = child.end;
  }
  if (!iinf || !iloc) return setParserState(metadata, PARSER_STATE_EMPTY_CONFIRMED);
  const info = parseAvifItemInfo(view, iinf);
  const locations = parseAvifItemLocations(view, iloc);
  if (!info.complete || !locations.complete) {
    return setParserState(metadata, PARSER_STATE_UNRESOLVED, { isIncomplete: true });
  }

  for (const itemId of info.exifIds) {
    const extents = locations.items.get(itemId);
    if (!extents || extents.length === 0) {
      return setParserState(metadata, PARSER_STATE_UNRESOLVED, { isIncomplete: true });
    }
    let itemLength = 0;
    for (const extent of extents) {
      itemLength += extent.length;
      if (!Number.isSafeInteger(itemLength) || itemLength > EXIF_MAX_VALUE_BYTES + 16) {
        return setParserState(metadata, PARSER_STATE_RESOURCE_LIMIT, { parserReason: 'avif-exif-item-size' });
      }
    }
    const itemBytes = new Uint8Array(itemLength);
    let copied = 0;
    for (const extent of extents) {
      let extentStart;
      if (extent.dataReferenceIndex !== 0) {
        return setParserState(metadata, PARSER_STATE_UNRESOLVED, { isIncomplete: true });
      }
      if (extent.constructionMethod === 0) extentStart = extent.offset;
      else if (extent.constructionMethod === 1 && idat) extentStart = idat.dataStart + extent.offset;
      else return setParserState(metadata, PARSER_STATE_UNRESOLVED, { isIncomplete: true });
      const extentEnd = extentStart + extent.length;
      if (!Number.isSafeInteger(extentEnd) || extentEnd > view.length) {
        return setParserState(metadata, PARSER_STATE_UNRESOLVED, {
          isIncomplete: true,
          suggestedSize: Number.isSafeInteger(extentEnd) ? extentEnd - 1 : AVIF_METADATA_HEAD_BUDGET_BYTES - 1,
        });
      }
      if (extent.constructionMethod === 1 && extentEnd > idat.end) {
        return setParserState(metadata, PARSER_STATE_UNRESOLVED, { isIncomplete: true });
      }
      itemBytes.set(view.subarray(extentStart, extentEnd), copied);
      copied += extent.length;
    }
    if (itemBytes.length < 4) return setParserState(metadata, PARSER_STATE_UNRESOLVED, { isIncomplete: true });
    const tiffOffset = readUint32BE(itemBytes, 0);
    const tiffStart = 4 + tiffOffset;
    if (!Number.isSafeInteger(tiffStart) || tiffStart + 8 > itemBytes.length) {
      return setParserState(metadata, PARSER_STATE_UNRESOLVED, { isIncomplete: true });
    }
    const parsed = extractExifPayload(itemBytes.subarray(tiffStart), {
      allowExifPrefix: true,
      declaredLength: itemBytes.length - tiffStart,
    });
    Object.assign(metadata, parsed);
    metadataPartial ||= parsed.metadataPartial === true;
    if (parsed.parserState === PARSER_STATE_UNRESOLVED || parsed.parserState === PARSER_STATE_RESOURCE_LIMIT) {
      return setParserState(metadata, parsed.parserState, {
        isIncomplete: parsed.parserState === PARSER_STATE_UNRESOLVED,
        parserReason: parsed.parserReason,
      });
    }
  }
  return setParserState(metadata,
    Object.keys(metadata).length > 0 ? PARSER_STATE_RESOLVED : PARSER_STATE_EMPTY_CONFIRMED,
    metadataPartial ? { metadataPartial: true } : {});
}

function scanAvifMetaBox(view, inputComplete = false) {
  let offset = 0;
  while (offset + 8 <= view.length) {
    const box = readAvifBox(view, offset, view.length);
    if (!box || box.invalid) return { complete: false, foundMeta: false };
    if (box.type === 'meta') return { complete: box.end <= view.length, foundMeta: true, box };
    if (box.end > view.length) return { complete: false, foundMeta: false, nextOffset: box.end };
    offset = box.end;
  }
  return { complete: inputComplete && offset === view.length, foundMeta: false };
}

function extractAvifMetadata(buffer, options = {}) {
  const view = new Uint8Array(buffer);
  const scan = scanAvifMetaBox(view, options.inputComplete === true);
  if (scan.foundMeta && scan.box && scan.complete) {
    const exifMetadata = extractAvifExifFromMetaBox(view, scan.box);
    if (exifMetadata.parserState !== PARSER_STATE_EMPTY_CONFIRMED) return exifMetadata;
    if (scan.complete) return exifMetadata;
  }
  if (scan.complete) return setParserState({}, PARSER_STATE_EMPTY_CONFIRMED);
  return setParserState({}, PARSER_STATE_UNRESOLVED, {
    isIncomplete: true,
    suggestedSize: Number.isSafeInteger(scan.nextOffset)
      ? scan.nextOffset - 1
      : AVIF_METADATA_HEAD_BUDGET_BYTES - 1,
  });
}

/**
 * Safetensors形式のメタデータを抽出
 * @param {ArrayBuffer} buffer - データ
 * @returns {Object} - 抽出されたメタデータ
 */
function extractSafetensorsMetadata(buffer, options = {}) {
  const view = new Uint8Array(buffer);
  const inputComplete = options.inputComplete === true;
  if (view.length < SAFETENSORS_HEADER_LENGTH_BYTES) {
    if (inputComplete) {
      return setParserState({}, PARSER_STATE_EMPTY_CONFIRMED, {
        parserReason: 'truncated',
      });
    }
    return setParserState({}, PARSER_STATE_UNRESOLVED, {
      isIncomplete: true,
      // suggestedSizeはRangeのinclusive endとして返す。
      suggestedSize: SAFETENSORS_HEADER_LENGTH_BYTES - 1,
    });
  }

  const headerSize = getUint64LE(view, 0);
  if (!Number.isSafeInteger(headerSize) || headerSize > SAFETENSORS_MAX_HEADER_BYTES) {
    if (inputComplete) {
      return setParserState({}, PARSER_STATE_RESOURCE_LIMIT, {
        parserReason: 'resource-limit',
      });
    }
    return setParserState({}, PARSER_STATE_UNRESOLVED, {
      isIncomplete: true,
      parserReason: 'resource-limit',
      suggestedSize: SAFETENSORS_METADATA_HEAD_BUDGET_BYTES - 1,
    });
  }
  if (headerSize > view.length - SAFETENSORS_HEADER_LENGTH_BYTES) {
    if (inputComplete) {
      return setParserState({}, PARSER_STATE_EMPTY_CONFIRMED, {
        parserReason: 'truncated',
      });
    }
    return setParserState({}, PARSER_STATE_UNRESOLVED, {
      isIncomplete: true,
      // length prefixとheader本体を合わせた必要byte数をinclusive endへ変換する。
      suggestedSize: Math.min(
        SAFETENSORS_METADATA_HEAD_BUDGET_BYTES - 1,
        headerSize + SAFETENSORS_HEADER_LENGTH_BYTES - 1,
      ),
    });
  }

  const metadata = extractSafetensorsMetadataLegacy(buffer);
  const cleanMetadata = {};
  for (const key of Object.keys(metadata)) {
    if (key !== 'isIncomplete' && key !== 'suggestedSize') cleanMetadata[key] = metadata[key];
  }
  return setParserState(
    cleanMetadata,
    Object.keys(cleanMetadata).length > 0
      ? PARSER_STATE_RESOLVED
      : PARSER_STATE_EMPTY_CONFIRMED,
  );
}

function extractSafetensorsMetadataLegacy(buffer) {
  const view = new Uint8Array(buffer);

  if (view.length < SAFETENSORS_HEADER_LENGTH_BYTES) {
    return { isIncomplete: true, suggestedSize: 65536 };
  }

  const headerSize = getUint64LE(view, 0);

  // ヘッダーサイズが現在のバッファを超えている場合
  if (headerSize > view.length - SAFETENSORS_HEADER_LENGTH_BYTES) {
    // 巨大すぎるヘッダー（100MB超）は異常とみなす
    if (headerSize > 100 * 1024 * 1024) return {};

    return {
      isIncomplete: true,
      suggestedSize: headerSize + 8
    };
  }

  if (headerSize <= 0) {
    return {};
  }

  try {
    const headerBytes = view.slice(8, 8 + headerSize);
    const headerStr = new TextDecoder('utf-8').decode(headerBytes);
    const header = JSON.parse(headerStr);

    // Safetensorsは通常 __metadata__ キーにユーザー定義情報が入っている
    if (header.__metadata__) {
      return header.__metadata__;
    }

    return {};
  } catch (e) {
    console.error('Safetensors parse error:', e);
    return {};
  }
}

/**
 * 特定の Exif タグの値を検索
 * @param {Uint8Array} data - Exifデータ
 * @param {number} tiffStart - TIFFヘッダー開始位置
 * @param {boolean} isLittleEndian - Little Endianかどうか
 * @param {number} targetTagId - 検索するタグID (例: 0x9286)
 * @returns {Uint8Array|null} - タグのデータ、見つからない場合はnull
 */
/**
 * Exif UserCommentを解析
 * @param {Uint8Array} data - UserCommentデータ
 * @param {boolean} isLittleEndian - Little Endianかどうか
 * @returns {string|null} - 解析されたテキスト、失敗時はnull
 */
function parseExifUserComment(data, isLittleEndian) {
  if (data.length < 8) {
    return null;
  }

  // 先頭4バイトが\0\0\0\0の場合、オフセット4から文字コード識別子
  let charCode, textData;
  if (data.length >= 12 &&
    data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 0) {
    charCode = data.slice(4, 12);
    textData = data.slice(12);
  } else if (data.length >= 8) {
    charCode = data.slice(0, 8);
    textData = data.slice(8);
  } else {
    return null;
  }

  const charCodeStr = String.fromCharCode(...charCode);

  try {
    // UNICODE (UTF-16)
    if (charCodeStr.startsWith('UNICODE')) {
      if (textData.length >= 2) {
        // BOMチェック
        const bom = (textData[0] << 8) | textData[1];
        if (bom === 0xFEFF) {
          // Big Endian UTF-16 (BOMあり)
          const decoded = new TextDecoder('utf-16be').decode(textData.slice(2));
          return decoded.replace(/\0+$/, ''); // NULL終端を除去
        } else if (bom === 0xFFFE) {
          // Little Endian UTF-16 (BOMあり)
          const decoded = new TextDecoder('utf-16le').decode(textData.slice(2));
          return decoded.replace(/\0+$/, '');
        }

        // BOMなし: ヒューリスティック判定
        // 最初の2バイトをLE/BEで読んでASCII範囲かチェック
        const firstLE = textData[0] | (textData[1] << 8);
        const firstBE = (textData[0] << 8) | textData[1];

        // ASCII範囲 (0x0020-0x007E) ならLEの可能性が高い
        const isLE = (firstLE >= 0x0020 && firstLE <= 0x007E);

        const encoding = isLE ? 'utf-16le' : 'utf-16be';
        const decoded = new TextDecoder(encoding).decode(textData);
        return decoded.replace(/\0+$/, '');
      }
    }

    // ASCII/UTF-8
    if (charCodeStr.startsWith('ASCII')) {
      const decoded = new TextDecoder('utf-8').decode(textData);
      return decoded.replace(/\0+$/, '');
    }

    // JIS (ISO-2022-JP)
    if (charCodeStr.startsWith('JIS')) {
      // UTF-8として試行
      const decoded = new TextDecoder('utf-8').decode(textData);
      return decoded.replace(/\0+$/, '');
    }

    // 未定義 (すべて0x00)
    const isAllZero = charCode.every(byte => byte === 0x00);
    if (isAllZero) {
      const decoded = new TextDecoder('utf-8').decode(textData);
      const trimmed = decoded.replace(/\0+$/, '');
      return trimmed || null; // 空文字列の場合はnull
    }

    // デフォルトでUTF-8として試行
    const decoded = new TextDecoder('utf-8').decode(textData);
    return decoded.replace(/\0+$/, '');

  } catch (e) {
    console.error('UserComment解析エラー:', e);
    return null;
  }
}

/**
 * XMP テキストからメタデータを抽出
 * @param {string} xmpText - XMP XML 文字列
 * @returns {Object} - 抽出されたメタデータ
 */
function parseXmpMetadata(xmpText) {
  const metadata = {};

  // XMP は XML なので、簡易的な正規表現で主要なタグを抽出
  // 1. Stable Diffusion (Automatic1111) 等で使われる parameters 属性/タグ
  // 属性形式: parameters="..."
  const paramAttrMatch = xmpText.match(/parameters="([^"]+)"/);
  if (paramAttrMatch) {
    // 実体参照をデコード (簡易版: &quot;, &lt;, &gt;, &amp;, &#10;)
    metadata['parameters'] = paramAttrMatch[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&#10;/g, '\n')
      .replace(/&#13;/g, '\r');
  } else {
    // タグ形式: <...:parameters>...</...:parameters>
    const paramTagMatch = xmpText.match(/<[^:>]+:parameters>([\s\S]+?)<\/[^:>]+:parameters>/);
    if (paramTagMatch) {
      metadata['parameters'] = paramTagMatch[1].trim();
    }
  }

  // 2. 他の一般的なメタデータ (Description 等)
  if (!metadata['parameters']) {
    // dc:description 内の rdf:li
    const descMatch = xmpText.match(/<dc:description>[\s\S]*?<rdf:li[^>]*>([\s\S]+?)<\/rdf:li>[\s\S]*?<\/dc:description>/);
    if (descMatch) {
      metadata['Description'] = descMatch[1].trim();
    }
  }

  return metadata;
}

/**
 * 画像からメタデータを抽出 (メインエントリーポイント)
 * @param {ArrayBuffer} buffer - 画像バイナリデータ
 * @returns {Object} - 抽出されたメタデータ
 */
function extractMetadata(buffer, options = {}) {
  const detectedFormat = options.format || detectImageFormat(buffer);
  const inputComplete = options.inputComplete !== false;

  if (!detectedFormat) {
    // 診断ログ: 最初の16バイトをヘキサ表示
    const view = new Uint8Array(buffer.slice(0, 16));
    const hex = Array.from(view).map(b => b.toString(16).padStart(2, '0')).join(' ');
    if (typeof debugLog === 'function') {
      debugLog(`[AI Meta Viewer] extractMetadata: format not detected. Buffer size: ${buffer.byteLength}, header hex: ${hex}`);
    } else {
      console.log(`[AI Meta Viewer] extractMetadata: format not detected. Buffer size: ${buffer.byteLength}, header hex: ${hex}`);
    }
    return setParserState({}, PARSER_STATE_UNSUPPORTED_FORMAT);
  }

  if (typeof debugLog === 'function') {
    debugLog(`[AI Meta Viewer] extractMetadata: format detected: ${detectedFormat}, buffer size: ${buffer.byteLength}`);
  } else {
    console.log(`[AI Meta Viewer] extractMetadata: format detected: ${detectedFormat}, buffer size: ${buffer.byteLength}`);
  }

  switch (detectedFormat) {
    case 'png':
      return extractPngMetadata(buffer);
    case 'jpeg':
      return extractJpegMetadata(buffer, { inputComplete });
    case 'webp':
      return extractWebpMetadata(buffer, { inputComplete });
    case 'avif':
      return extractAvifMetadata(buffer, { inputComplete });
    case 'safetensors':
      return extractSafetensorsMetadata(buffer, { inputComplete });
    default:
      return setParserState({}, PARSER_STATE_UNSUPPORTED_FORMAT);
  }
}

/**
 * PNG IHDR チャンクから ColorType を確認
 * @param {ArrayBuffer} buffer - PNG画像バイナリデータ
 * @returns {boolean} - αチャンネルあり（ColorType 4 or 6）の場合 true
 */
function checkPngIHDRHasAlpha(buffer) {
  const view = new Uint8Array(buffer);

  // PNGシグネチャ確認 (8バイト)
  if (buffer.byteLength < 33) return false; // IHDR最小サイズ

  // IHDRチャンクは通常、シグネチャ直後（オフセット8）
  const offset = 8;

  // チャンク長 (4バイト, Big Endian) - IHDRは常に13バイト
  const length = (view[offset] << 24) | (view[offset + 1] << 16) |
    (view[offset + 2] << 8) | view[offset + 3];

  if (length !== 13) return false;

  // チャンク型 (4バイト) - "IHDR"
  const type = String.fromCharCode(view[offset + 4], view[offset + 5],
    view[offset + 6], view[offset + 7]);

  if (type !== 'IHDR') return false;

  // ColorType (オフセット8+4+4+4+1+1+1 = 17からデータ開始 + 9バイト目)
  const colorType = view[offset + 4 + 4 + 9];

  // ColorType 4: Grayscale + Alpha, 6: RGB + Alpha
  return colorType === 4 || colorType === 6;
}

/**
 * ビットストリームから Stealth PNG Info をデコード
 * @param {string} bitStream - ビットストリーム ('0' と '1' の文字列)
 * @param {string} mode - 'Alpha' または 'RGB'
 * @returns {Object|null} - { data: string, mode: string, compressed: boolean }
 */
function processStealthStream(bitStream, mode) {
  const signatures = {
    'stealth_pnginfo': { mode: 'Alpha', compressed: false },
    'stealth_pngcomp': { mode: 'Alpha', compressed: true },
    'stealth_rgbinfo': { mode: 'RGB', compressed: false },
    'stealth_rgbcomp': { mode: 'RGB', compressed: true },
  };

  const sigLen = 'stealth_pnginfo'.length * 8; // 128 bits

  // 最小ビットストリーム長チェック (シグネチャ + 長さフィールド32bit)
  if (bitStream.length < sigLen + 32) return null;

  // シグネチャ抽出
  const sigBinary = bitStream.substring(0, sigLen);
  const sigText = binaryToText(sigBinary);

  // シグネチャ確認
  if (!(sigText in signatures) || signatures[sigText].mode !== mode) {
    return null;
  }

  const compressed = signatures[sigText].compressed;

  // データ長を読み取り (32ビット)
  let currentStream = bitStream.substring(sigLen);
  const lenBinary = currentStream.substring(0, 32);
  const paramLen = parseInt(lenBinary, 2);
  currentStream = currentStream.substring(32);

  // データビット不足チェック
  if (currentStream.length < paramLen) return null;

  // バイナリデータ抽出
  const binaryData = currentStream.substring(0, paramLen);
  const byteArray = new Uint8Array(binaryData.length / 8);

  for (let i = 0; i < byteArray.length; i++) {
    byteArray[i] = parseInt(binaryData.substring(i * 8, (i + 1) * 8), 2);
  }

  try {
    let decodedData;

    if (compressed) {
      // pako で解凍
      if (typeof pako === 'undefined') {
        return { data: '[pako not loaded]', mode: mode, compressed: true };
      }
      decodedData = pako.inflate(byteArray, { to: 'string' });
    } else {
      // UTF-8 デコード
      decodedData = new TextDecoder('utf-8', { fatal: true }).decode(byteArray);
    }

    return { data: decodedData, mode: mode, compressed: compressed };
  } catch (e) {
    return { data: '[decoding error]', mode: mode, compressed: compressed };
  }
}

/**
 * バイナリ文字列をテキストに変換
 * @param {string} binaryStr - '0' と '1' の文字列
 * @returns {string} - デコードされたテキスト
 */
function binaryToText(binaryStr) {
  try {
    const bytes = new Uint8Array(binaryStr.length / 8);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(binaryStr.substr(i * 8, 8), 2);
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return '';
  }
}

/**
 * PNG画像のバイナリデータを取得し、メタデータを書き換えた新しいデータを返す
 * (既存の tEXt/iTXt チャンクを上書き、または新規挿入)
 * @param {ArrayBuffer} buffer - 元の画像データ
 * @param {string} text - 書き込むプロンプトテキスト
 * @returns {Uint8Array} - 書き換え後の画像データ
 */
function writePngMetadata(buffer, text) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  let offset = 8; // Skip PNG header

  // ヘッダーをコピー
  chunks.push(bytes.slice(0, 8));

  let inserted = false;

  while (offset < bytes.length) {
    const length = new DataView(bytes.buffer, offset, 4).getUint32(0);
    const type = new TextDecoder('ascii').decode(bytes.slice(offset + 4, offset + 8));

    // 既存の parameters チャンクがあればスキップ（上書きの代わり）
    if (type === 'tEXt' || type === 'iTXt') {
      const chunkContent = bytes.slice(offset + 8, offset + 8 + length);
      let keywordEnd = -1;
      for (let i = 0; i < chunkContent.length; i++) {
        if (chunkContent[i] === 0) {
          keywordEnd = i;
          break;
        }
      }

      if (keywordEnd !== -1) {
        const keyword = new TextDecoder('ascii').decode(chunkContent.slice(0, keywordEnd));
        if (keyword === 'parameters') {
          offset += length + 12;
          continue;
        }
      }
    }

    const fullChunk = bytes.slice(offset, offset + length + 12);
    chunks.push(fullChunk);

    // IHDR チャンクの直後に新しい parameters チャンクを挿入する
    if (type === 'IHDR' && !inserted) {
      chunks.push(createPngTextChunk('parameters', text));
      inserted = true;
    }

    offset += length + 12;
    if (offset > bytes.length - 4) break; // 安全策
  }

  // Flatten chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  return result;
}

/**
 * PNG tEXt チャンクを生成
 */
function createPngTextChunk(keyword, text) {
  const encoder = new TextEncoder();
  const kwBytes = encoder.encode(keyword);
  const textBytes = encoder.encode(text);

  const length = kwBytes.length + 1 + textBytes.length;
  const buffer = new ArrayBuffer(length + 12);
  const view = new DataView(buffer);

  // Length
  view.setUint32(0, length);

  // Type: tEXt
  view.setUint8(4, 0x74); // t
  view.setUint8(5, 0x45); // E
  view.setUint8(6, 0x58); // X
  view.setUint8(7, 0x74); // t

  const bytes = new Uint8Array(buffer);
  // Keyword + Null separator + Text
  bytes.set(kwBytes, 8);
  bytes.set([0], 8 + kwBytes.length);
  bytes.set(textBytes, 9 + kwBytes.length);

  // CRC
  const crcData = bytes.slice(4, 8 + length);
  const crc = computeCrc32(crcData);
  view.setUint32(8 + length, crc);

  return bytes;
}

// CRC32逐次処理API
function getCrc32Table() {
  const globalObj = typeof self !== 'undefined' ? self : window;
  return globalObj._crcTable || (globalObj._crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < table.length; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) {
        value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
      }
      table[i] = value;
    }
    return table;
  })());
}

function createCrc32State() {
  return 0xFFFFFFFF;
}

function updateCrc32(state, data) {
  if (!data || typeof data.length !== 'number') {
    throw new TypeError('CRC32 update data must be an array-like byte sequence.');
  }

  const table = getCrc32Table();
  let crc = state >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return crc >>> 0;
}

function finalizeCrc32(state) {
  return ((state >>> 0) ^ 0xFFFFFFFF) >>> 0;
}

function computeCrc32(data) {
  return finalizeCrc32(updateCrc32(createCrc32State(), data));
}

/**
 * 画像形式を判別してメタデータを書き換える (統合エントリポイント)
 */
async function rewriteImageMetadata(buffer, text) {
  const format = detectImageFormat(buffer);
  debugLog(`[AI Meta Viewer] Rewriting metadata for format: ${format}`);

  switch (format) {
    case 'png':
      return writePngMetadata(buffer, text);
    case 'webp':
      return writeWebPMetadata(buffer, text);
    case 'jpeg':
      return writeJpegMetadata(buffer, text);
    case 'avif':
      throw new Error('AVIF metadata rewriting is not supported. AVIF uses ISOBMFF container format which requires a different approach.');
    default:
      throw new Error(`Unsupported format for rewriting: ${format}`);
  }
}

/**
 * WebPにメタデータ(XMP)を埋め込む
 * シンプルにVP8Xヘッダを更新し、末尾にXMPチャンクを追加（または上書き）
 */
function writeWebPMetadata(buffer, text) {
  const view = new Uint8Array(buffer);
  const xmpHeader = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">';
  const xmpFooter = '</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const xmpContent = xmpHeader + text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + xmpFooter;
  const xmpBytes = new TextEncoder().encode(xmpContent);

  // RIFF(4) + Size(4) + WEBP(4)
  // 既存の XMP チャンクを探して削除するための簡易実装
  // 実際にはチャンクをパースして再構築するのが安全だが、
  // ここでは新しい XMP チャンクを生成して IDAT (または VP8/VP8L) の後に追加

  const chunks = [];
  let offset = 12;
  while (offset < view.length - 8) {
    const type = String.fromCharCode(...view.slice(offset, offset + 4));
    const size = view[offset + 4] | (view[offset + 5] << 8) | (view[offset + 6] << 16) | (view[offset + 7] << 24);
    const fullSize = 8 + size + (size % 2);

    if (type !== 'XMP ') { // 既存の XMP はスキップ
      chunks.push(view.slice(offset, offset + fullSize));
    }
    offset += fullSize;
  }

  // VP8X チャンクが存在しない場合は追加し、フラグを立てる必要があるが、
  // 多くのAI生成WebPは既にVP8Xを持っているか、末尾追加でも読み取れる場合が多い
  // ここではシンプルに結合
  const newSize = 4 + chunks.reduce((acc, c) => acc + c.length, 0) + 8 + xmpBytes.length + (xmpBytes.length % 2);
  const out = new Uint8Array(8 + newSize);

  out.set([0x52, 0x49, 0x46, 0x46]); // RIFF
  const outView = new DataView(out.buffer);
  outView.setUint32(4, newSize, true);
  out.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP

  let currentPos = 12;
  for (const c of chunks) {
    out.set(c, currentPos);
    currentPos += c.length;
  }

  // XMP チャンク追加
  out.set(new TextEncoder().encode('XMP '), currentPos);
  outView.setUint32(currentPos + 4, xmpBytes.length, true);
  out.set(xmpBytes, currentPos + 8);

  return out;
}

/**
 * JPEG/AVIFにメタデータ(COMセグメント)を埋め込む
 * シンプルに APP0/APP1 の直後に COM (Comment) セグメントを挿入
 */
function writeJpegMetadata(buffer, text) {
  const view = new Uint8Array(buffer);
  const textBytes = new TextEncoder().encode(text);

  // COM segment length field is 2 bytes (max 65535, including the 2-byte length field itself)
  // So max text payload is 65533 bytes
  const MAX_COM_PAYLOAD = 65533;
  if (textBytes.length > MAX_COM_PAYLOAD) {
    throw new Error(`Metadata text too large for JPEG COM segment (${textBytes.length} bytes > ${MAX_COM_PAYLOAD} bytes max). Consider using a shorter prompt.`);
  }

  // COM marker: FF FE, Length: 2 + textBytes.length
  const comSegment = new Uint8Array(2 + 2 + textBytes.length);
  comSegment[0] = 0xFF;
  comSegment[1] = 0xFE;
  comSegment[2] = ((textBytes.length + 2) >> 8) & 0xFF;
  comSegment[3] = (textBytes.length + 2) & 0xFF;
  comSegment.set(textBytes, 4);

  // JPEG/AVIF (Exif) の場合、SOI (FF D8) または ftyp の直後に挿入
  let insertPos = 2;
  if (view[0] !== 0xFF || view[1] !== 0xD8) {
    // AVIF の場合は ftyp チャンクの次
    const ftypIndex = findSequence(view, [0x66, 0x74, 0x79, 0x70]);
    if (ftypIndex !== -1) {
      const size = (view[ftypIndex - 4] << 24) | (view[ftypIndex - 3] << 16) | (view[ftypIndex - 2] << 8) | view[ftypIndex - 1];
      insertPos = ftypIndex - 4 + size;
    }
  }

  const out = new Uint8Array(view.length + comSegment.length);
  out.set(view.slice(0, insertPos), 0);
  out.set(comSegment, insertPos);
  out.set(view.slice(insertPos), insertPos + comSegment.length);

  return out;
}
