// parser.js - 画像メタデータ抽出モジュール

/**
 * 対象キーワードリスト (廃止: すべてのメタデータを取得するため)
 */
// const TARGET_KEYWORDS = [ ... ];

/**
 * 画像形式を判定
 * @param {ArrayBuffer} buffer - 画像バイナリデータ
 * @returns {string|null} - 'png', 'jpeg', 'webp', 'avif', または null
 */
function detectImageFormat(buffer) {
  const view = new Uint8Array(buffer);

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (view[0] === 0x89 && view[1] === 0x50 && view[2] === 0x4E && view[3] === 0x47) {
    return 'png';
  }

  // JPEG: FF D8 FF
  if (view[0] === 0xFF && view[1] === 0xD8 && view[2] === 0xFF) {
    return 'jpeg';
  }

  // WebP: RIFF ... WEBP
  if (view[0] === 0x52 && view[1] === 0x49 && view[2] === 0x46 && view[3] === 0x46 &&
    view[8] === 0x57 && view[9] === 0x45 && view[10] === 0x42 && view[11] === 0x50) {
    return 'webp';
  }

  // AVIF: ... ftyp ... avif
  const ftypIndex = findSequence(view, [0x66, 0x74, 0x79, 0x70]); // 'ftyp'
  if (ftypIndex !== -1 && ftypIndex + 8 < view.length) {
    const brand = view.slice(ftypIndex + 4, ftypIndex + 8);
    const brandStr = String.fromCharCode(...brand);
    if (brandStr === 'avif' || brandStr === 'avis') {
      return 'avif';
    }
  }

  // Safetensors: First 8 bytes is a little-endian Uint64 for header size
  if (view.length >= 8) {
    const headerSize = getUint64LE(view, 0);
    // 数字として妥当な範囲か (0より大きく、100MB以下程度)
    if (headerSize > 0 && headerSize < 100 * 1024 * 1024) {
      // 最初の8バイトの直後、または数バイトのパディングの後に '{' (JSONの開始) があれば Safetensors
      // 通常は 8バイト目(index 8)にあるが、念のため 12バイト目まで確認
      for (let i = 8; i < Math.min(view.length, 12); i++) {
        if (view[i] === 0x7B) { // '{' character
          return 'safetensors';
        }
      }
      // バッファが不足（8バイト〜）していても、数値的に妥当なら一旦 Safetensors とみなして再取得を促す
      if (view.length < 12) {
        return 'safetensors';
      }
    }
  }

  return null;
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

  while (offset < view.length) {
    // チャンク長を読み取るための最低4バイトがあるか
    if (offset + 4 > view.length) break;

    // チャンク長を読み取り (Big Endian)
    const length = (view[offset] << 24) | (view[offset + 1] << 16) |
      (view[offset + 2] << 8) | view[offset + 3];

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
        Object.assign(metadata, { isIncomplete: true, suggestedSize: offset + 4 + 4 + length + 4 + 1024 });
        return metadata;
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
    }

    // IENDチャンクで終了
    if (type === 'IEND') {
      break;
    }

    offset += length + 4; // データ + CRC
  }

  return metadata;
}

/**
 * PNG形式のファイル末尾のバイナリ（部分フェッチ用）からメタデータを抽出
 * @param {ArrayBuffer} buffer - 画像バイナリデータの末尾部分
 * @returns {Object} - 抽出されたメタデータ
 */
function extractPngTailMetadata(buffer) {
  const view = new Uint8Array(buffer);
  const metadata = {};

  // バッファ全体を走査して tEXt, iTXt チャンクを探す
  let offset = 0;
  while (offset < view.length - 8) {
    const chunkType = String.fromCharCode(view[offset], view[offset + 1], view[offset + 2], view[offset + 3]);

    if (chunkType === 'tEXt' || chunkType === 'iTXt') {
      // チャンクの手前4バイトがLength
      if (offset >= 4) {
        const length = (view[offset - 4] << 24) | (view[offset - 3] << 16) | (view[offset - 2] << 8) | view[offset - 1];
        if (offset + 4 + length + 4 <= view.length) {
          const type = chunkType;
          let currentOffset = offset + 4; // Length(4) + Type(4)

          // tEXt / iTXt チャンク処理 (共通ヘルパー呼び出し)
          if (type === 'tEXt' || type === 'iTXt') {
            const chunkData = view.slice(currentOffset, currentOffset + length);
            parsePngTextChunk(type, chunkData, metadata);
          }
        }
      }
    }
    offset++;
  }

  return metadata;
}

/**
 * JPEG/AVIF形式のメタデータを抽出
 * @param {ArrayBuffer} buffer - 画像バイナリデータ
 * @returns {Object} - 抽出されたメタデータ
 */
function extractJpegMetadata(buffer) {
  const view = new Uint8Array(buffer);
  const metadata = {};

  // Exifヘッダーを検索 ("Exif\0\0")
  const exifMarker = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];
  const exifIndex = findSequence(view, exifMarker);

  if (exifIndex === -1) {
    return metadata;
  }

  // TIFFヘッダー位置 (Exifマーカー + 6バイト)
  const tiffStart = exifIndex + 6;

  // エンディアン判定
  const endianMarker = String.fromCharCode(view[tiffStart], view[tiffStart + 1]);
  const isLittleEndian = endianMarker === 'II';

  if (endianMarker !== 'II' && endianMarker !== 'MM') {
    return metadata; // 不正なTIFFヘッダー
  }

  // 1. ImageDescription (0x010E)
  const descData = getExifTagValue(view, tiffStart, isLittleEndian, 0x010E);
  if (descData) {
    const text = new TextDecoder('utf-8').decode(descData).replace(/\0+$/, '');
    if (text) metadata['Description'] = text;
  }

  // 2. UserComment (0x9286)
  const userCommentData = getExifTagValue(view, tiffStart, isLittleEndian, 0x9286);
  if (userCommentData) {
    const parsedComment = parseExifUserComment(userCommentData, isLittleEndian);
    if (parsedComment) {
      metadata['parameters'] = parsedComment;
    }
  }

  return metadata;
}

/**
 * WebP形式のメタデータを抽出
 * @param {ArrayBuffer} buffer - 画像バイナリデータ
 * @returns {Object} - 抽出されたメタデータ
 */
function extractWebpMetadata(buffer) {
  const view = new Uint8Array(buffer);
  const metadata = {};

  // RIFFヘッダーを確認
  if (view.length < 12) {
    return { isIncomplete: true, suggestedSize: 65536 };
  }

  // RIFFサイズ (Little Endian)
  const riffSize = view[4] | (view[5] << 8) | (view[6] << 16) | (view[7] << 24);
  const totalSize = riffSize + 8;

  // RIFFヘッダーをスキップ (12バイト: "RIFF" + size + "WEBP")
  let offset = 12;
  let foundMetadata = false;

  while (offset < view.length) {
    // チャンクヘッダー (型4B + サイズ4B) が読み取れるか
    if (offset + 8 > view.length) {
      // メタデータが見つかっていない場合、ファイルがまだ続くなら再取得
      if (!foundMetadata && view.length < totalSize) {
        return { isIncomplete: true, suggestedSize: totalSize };
      }
      break;
    }

    // チャンク型を読み取り
    const chunkType = String.fromCharCode(view[offset], view[offset + 1],
      view[offset + 2], view[offset + 3]);

    // チャンクサイズを読み取り (Little Endian)
    // 符号付き32bitの制限を避けるため、符号なしとして計算
    const chunkSize = (view[offset + 4]) + (view[offset + 5] << 8) +
      (view[offset + 6] << 16) + (view[offset + 7] * 16777216);

    // チャンクデータがバッファ内に収まっているか
    if (offset + 8 + chunkSize > view.length) {
      // このチャンクが EXIF または XMP の場合、またはメタデータが未発見でファイルが続く場合
      if (chunkType === 'EXIF' || chunkType === 'XMP ' || (!foundMetadata && view.length < totalSize)) {
        // ComfyUI の WebP 等で、巨大な画像チャンク（VP8 / VP8L）の後にメタデータがあるパターンを考慮
        if ((chunkType === 'VP8 ' || chunkType === 'VP8L') && chunkSize > 65536) {
          return { isIncomplete: true, requiresTailFetch: true };
        }
        return { isIncomplete: true, suggestedSize: Math.min(totalSize, offset + 8 + chunkSize) };
      }
      break;
    }

    offset += 8;

    // EXIFチャンク処理
    if (chunkType === 'EXIF') {
      const exifData = view.slice(offset, offset + chunkSize);

      // Exifヘッダー ("Exif\0\0") がある場合はスキップ。WebPは直接TIFFデータが入ることもあるが、仕様上はExifヘッダ付き
      let exifStart = 0;
      if (exifData[0] === 0x45 && exifData[1] === 0x78) { // "Exif\0\0"
        exifStart = 6;
      }

      const endianMarker = String.fromCharCode(exifData[exifStart], exifData[exifStart + 1]);
      const isLittleEndian = endianMarker === 'II';

      if (endianMarker === 'II' || endianMarker === 'MM') {
        // 1. ImageDescription (0x010E) - ComfyUI WebP等
        const descData = getExifTagValue(exifData, exifStart, isLittleEndian, 0x010E);
        if (descData) {
          const text = new TextDecoder('utf-8').decode(descData).replace(/\0+$/, '');
          if (text) {
            metadata['Description'] = text;
            foundMetadata = true;
          }
        }

        // 2. UserComment (0x9286) - Stable Diffusion等
        const userCommentData = getExifTagValue(exifData, exifStart, isLittleEndian, 0x9286);
        if (userCommentData) {
          const parsedComment = parseExifUserComment(userCommentData, isLittleEndian);
          if (parsedComment) {
            metadata['parameters'] = parsedComment;
            foundMetadata = true;
          }
        }
      }
    }

    // XMP チャンク処理
    if (chunkType === 'XMP ') {
      const xmpData = view.slice(offset, offset + chunkSize);
      const xmpText = new TextDecoder('utf-8').decode(xmpData);
      const xmpMetadata = parseXmpMetadata(xmpText);

      if (Object.keys(xmpMetadata).length > 0) {
        Object.assign(metadata, xmpMetadata);
        foundMetadata = true;
      }
    }

    // 次のチャンクへ (パディング考慮)
    offset += chunkSize;
    if (chunkSize % 2 === 1) {
      offset += 1; // パディングバイト
    }
  }

  // ループ終了後、メタデータが見つからず、かつファイル全体を読み切っていない場合
  if (!foundMetadata && view.length < totalSize) {
    return { isIncomplete: true, suggestedSize: totalSize };
  }

  return metadata;
}

/**
 * WebP形式のファイル末尾のバイナリからメタデータを抽出
 * @param {ArrayBuffer} buffer - 画像バイナリデータの末尾部分
 * @returns {Object} - 抽出されたメタデータ
 */
function extractWebpTailMetadata(buffer) {
  const view = new Uint8Array(buffer);
  const metadata = {};

  // バッファ内で "EXIF" または "XMP " を検索
  // WebP の EXIF ヘッダ: 'EXIF' (4B) + Size (4B)
  for (let i = 0; i < view.length - 8; i++) {
    const tag = String.fromCharCode(view[i], view[i + 1], view[i + 2], view[i + 3]);

    if (tag === 'EXIF') {
      const size = (view[i + 4]) + (view[i + 5] << 8) + (view[i + 6] << 16) + (view[i + 7] * 16777216);
      const dataStart = i + 8;
      if (dataStart + size <= view.length) {
        const exifData = view.slice(dataStart, dataStart + size);

        let exifStart = 0;
        if (exifData[0] === 0x45 && exifData[1] === 0x78) { exifStart = 6; }

        const endianMarker = String.fromCharCode(exifData[exifStart], exifData[exifStart + 1]);
        const isLittleEndian = endianMarker === 'II';

        if (endianMarker === 'II' || endianMarker === 'MM') {
          // ImageDescription
          const descData = getExifTagValue(exifData, exifStart, isLittleEndian, 0x010E);
          if (descData) {
            const text = new TextDecoder('utf-8').decode(descData).replace(/\0+$/, '');
            if (text) metadata['Description'] = text;
          }

          // UserComment
          const userCommentData = getExifTagValue(exifData, exifStart, isLittleEndian, 0x9286);
          if (userCommentData) {
            const parsedComment = parseExifUserComment(userCommentData, isLittleEndian);
            if (parsedComment) metadata['parameters'] = parsedComment;
          }
        }
      }
    }

    if (tag === 'XMP ') {
      const size = (view[i + 4]) + (view[i + 5] << 8) + (view[i + 6] << 16) + (view[i + 7] * 16777216);
      const dataStart = i + 8;
      if (dataStart + size <= view.length) {
        const xmpData = view.slice(dataStart, dataStart + size);
        const xmpText = new TextDecoder('utf-8').decode(xmpData);
        const xmpMetadata = parseXmpMetadata(xmpText);
        Object.assign(metadata, xmpMetadata);
      }
    }
  }

  return metadata;
}

/**
 * AVIF形式のメタデータを抽出
 * @param {ArrayBuffer} buffer - 画像バイナリデータ
 * @returns {Object} - 抽出されたメタデータ
 */
function extractAvifMetadata(buffer) {
  // AVIFはJPEGと同様のExif処理
  return extractJpegMetadata(buffer);
}

/**
 * Safetensors形式のメタデータを抽出
 * @param {ArrayBuffer} buffer - データ
 * @returns {Object} - 抽出されたメタデータ
 */
function extractSafetensorsMetadata(buffer) {
  const view = new Uint8Array(buffer);

  if (view.length < 8) {
    return { isIncomplete: true, suggestedSize: 65536 };
  }

  const headerSize = getUint64LE(view, 0);

  // ヘッダーサイズが現在のバッファを超えている場合
  if (headerSize > view.length - 8) {
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
function getExifTagValue(data, tiffStart, isLittleEndian, targetTagId) {
  const tagBytes = isLittleEndian
    ? [targetTagId & 0xFF, (targetTagId >> 8) & 0xFF]
    : [(targetTagId >> 8) & 0xFF, targetTagId & 0xFF];

  for (let i = tiffStart; i < data.length - 12; i++) {
    if (data[i] === tagBytes[0] && data[i + 1] === tagBytes[1]) {
      // 形式 (2バイト), 個数 (4バイト)
      const count = isLittleEndian
        ? data[i + 4] | (data[i + 5] << 8) | (data[i + 6] << 16) | (data[i + 7] << 24)
        : (data[i + 4] << 24) | (data[i + 5] << 16) | (data[i + 6] << 8) | data[i + 7];

      const dataOffset = isLittleEndian
        ? data[i + 8] | (data[i + 9] << 8) | (data[i + 10] << 16) | (data[i + 11] << 24)
        : (data[i + 8] << 24) | (data[i + 9] << 16) | (data[i + 10] << 8) | data[i + 11];

      if (count <= 4) {
        return data.slice(i + 8, i + 8 + count);
      }

      const actualOffset = tiffStart + dataOffset;
      if (actualOffset + count <= data.length) {
        return data.slice(actualOffset, actualOffset + count);
      }
    }
  }
  return null;
}

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
function extractMetadata(buffer) {
  const format = detectImageFormat(buffer);

  if (!format) {
    // 診断ログ: 最初の16バイトをヘキサ表示
    const view = new Uint8Array(buffer.slice(0, 16));
    const hex = Array.from(view).map(b => b.toString(16).padStart(2, '0')).join(' ');
    if (typeof debugLog === 'function') {
      debugLog(`[AI Meta Viewer] extractMetadata: format not detected. Buffer size: ${buffer.byteLength}, header hex: ${hex}`);
    } else {
      console.log(`[AI Meta Viewer] extractMetadata: format not detected. Buffer size: ${buffer.byteLength}, header hex: ${hex}`);
    }
    return {};
  }

  if (typeof debugLog === 'function') {
    debugLog(`[AI Meta Viewer] extractMetadata: format detected: ${format}, buffer size: ${buffer.byteLength}`);
  } else {
    console.log(`[AI Meta Viewer] extractMetadata: format detected: ${format}, buffer size: ${buffer.byteLength}`);
  }

  switch (format) {
    case 'png':
      return extractPngMetadata(buffer);
    case 'jpeg':
      return extractJpegMetadata(buffer);
    case 'webp':
      return extractWebpMetadata(buffer);
    case 'avif':
      return extractAvifMetadata(buffer);
    case 'safetensors':
      return extractSafetensorsMetadata(buffer);
    default:
      return {};
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

// CRC32 implementation
function computeCrc32(data) {
  let crc = 0xFFFFFFFF;
  const globalObj = typeof self !== 'undefined' ? self : window;
  const table = globalObj._crcTable || (globalObj._crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
      }
      t[i] = c;
    }
    return t;
  })());

  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
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
    case 'avif':
      return writeJpegMetadata(buffer, text); // AVIFもJPEG同様APP1/Exifを使用
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
