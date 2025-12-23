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
 * PNG形式のメタデータを抽出
 * @param {ArrayBuffer} buffer - 画像バイナリデータ
 * @returns {Object} - 抽出されたメタデータ
 */
function extractPngMetadata(buffer) {
  const view = new Uint8Array(buffer);
  const metadata = {};

  // PNGシグネチャをスキップ (8バイト)
  let offset = 8;

  while (offset < view.length) {
    // チャンク長を読み取るための最低4バイトがあるか
    if (offset + 4 > view.length) break;

    // チャンク長を読み取り (Big Endian)
    const length = (view[offset] << 24) | (view[offset + 1] << 16) |
      (view[offset + 2] << 8) | view[offset + 3];

    // データが不足しているかチェック (チャンク長4 + タイプ4 + データ + CRC4)
    if (offset + 4 + 4 + length + 4 > view.length) {
      // 興味のあるチャンク（tEXt, iTXt）であれば再取得を指示
      const type = String.fromCharCode(view[offset + 4], view[offset + 5],
        view[offset + 6], view[offset + 7]);

      if (type === 'tEXt' || type === 'iTXt') {
        return { isIncomplete: true, suggestedSize: offset + 4 + 4 + length + 4 + 1024 };
      }
      // それ以外（画像データなど）なら単に終了
      break;
    }

    offset += 4;

    // チャンク型を読み取り
    const type = String.fromCharCode(view[offset], view[offset + 1],
      view[offset + 2], view[offset + 3]);
    offset += 4;

    // tEXtチャンク処理
    if (type === 'tEXt') {
      const chunkData = view.slice(offset, offset + length);
      const nullIndex = chunkData.indexOf(0);
      if (nullIndex !== -1) {
        const keyword = new TextDecoder('utf-8').decode(chunkData.slice(0, nullIndex));
        const text = new TextDecoder('utf-8').decode(chunkData.slice(nullIndex + 1));

        // フィルタリングを廃止し、すべて保存
        metadata[keyword] = text;
      }
    }

    // iTXtチャンク処理
    if (type === 'iTXt') {
      const chunkData = view.slice(offset, offset + length);
      let pos = 0;

      // キーワード抽出
      const keywordEnd = chunkData.indexOf(0, pos);
      if (keywordEnd === -1) {
        offset += length + 4; // CRCをスキップ
        continue;
      }
      const keyword = new TextDecoder('utf-8').decode(chunkData.slice(pos, keywordEnd));
      pos = keywordEnd + 1;

      // 圧縮フラグ
      const compressionFlag = chunkData[pos];
      pos += 1;

      // 圧縮メソッド
      pos += 1; // スキップ

      // LanguageTag
      const langEnd = chunkData.indexOf(0, pos);
      if (langEnd === -1) {
        offset += length + 4;
        continue;
      }
      pos = langEnd + 1;

      // TranslatedKeyword
      const transEnd = chunkData.indexOf(0, pos);
      if (transEnd === -1) {
        offset += length + 4;
        continue;
      }
      pos = transEnd + 1;

      // テキストデータ
      if (compressionFlag === 0) { // 非圧縮のみ対応
        const text = new TextDecoder('utf-8').decode(chunkData.slice(pos));

        // フィルタリングを廃止し、すべて保存
        metadata[keyword] = text;
      }
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

  // UserCommentタグを検索 (0x9286)
  const userCommentData = findUserComment(view, tiffStart, isLittleEndian);

  if (userCommentData) {
    const parsedComment = parseExifUserComment(userCommentData, isLittleEndian);
    if (parsedComment) {
      // parametersキーワードとして保存
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

  // RIFFヘッダーをスキップ (12バイト: "RIFF" + size + "WEBP")
  let offset = 12;

  while (offset < view.length - 8) {
    // チャンク型を読み取り
    const chunkType = String.fromCharCode(view[offset], view[offset + 1],
      view[offset + 2], view[offset + 3]);
    offset += 4;

    // チャンクサイズを読み取り (Little Endian)
    const chunkSize = view[offset] | (view[offset + 1] << 8) |
      (view[offset + 2] << 16) | (view[offset + 3] << 24);
    offset += 4;

    // EXIFチャンク処理
    if (chunkType === 'EXIF') {
      const exifData = view.slice(offset, offset + chunkSize);

      // エンディアン判定
      const endianMarker = String.fromCharCode(exifData[0], exifData[1]);
      const isLittleEndian = endianMarker === 'II';

      if (endianMarker === 'II' || endianMarker === 'MM') {
        const userCommentData = findUserComment(exifData, 0, isLittleEndian);

        if (userCommentData) {
          const parsedComment = parseExifUserComment(userCommentData, isLittleEndian);
          if (parsedComment) {
            metadata['parameters'] = parsedComment;
          }
        }
      }
    }

    // 次のチャンクへ (パディング考慮)
    offset += chunkSize;
    if (chunkSize % 2 === 1) {
      offset += 1; // パディングバイト
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
 * UserCommentタグを検索
 * @param {Uint8Array} data - Exifデータ
 * @param {number} tiffStart - TIFFヘッダー開始位置
 * @param {boolean} isLittleEndian - Little Endianかどうか
 * @returns {Uint8Array|null} - UserCommentデータ、見つからない場合はnull
 */
function findUserComment(data, tiffStart, isLittleEndian) {
  // UserCommentタグID: 0x9286
  const tagBytes = isLittleEndian ? [0x86, 0x92] : [0x92, 0x86];

  for (let i = tiffStart; i < data.length - 12; i++) {
    if (data[i] === tagBytes[0] && data[i + 1] === tagBytes[1]) {
      // タグが見つかった
      // データ型 (2バイト) をスキップ
      // データ数 (4バイト) を読み取り
      const count = isLittleEndian
        ? data[i + 4] | (data[i + 5] << 8) | (data[i + 6] << 16) | (data[i + 7] << 24)
        : (data[i + 4] << 24) | (data[i + 5] << 16) | (data[i + 6] << 8) | data[i + 7];

      // データオフセット (4バイト) を読み取り
      const dataOffset = isLittleEndian
        ? data[i + 8] | (data[i + 9] << 8) | (data[i + 10] << 16) | (data[i + 11] << 24)
        : (data[i + 8] << 24) | (data[i + 9] << 16) | (data[i + 10] << 8) | data[i + 11];

      // データが4バイト以下の場合、オフセット位置に直接データが入っている
      if (count <= 4) {
        return data.slice(i + 8, i + 8 + count);
      }

      // データが4バイト超の場合、オフセットを使用
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
    console.log(`[AI Meta Viewer] extractMetadata: format not detected. Buffer size: ${buffer.byteLength}, header hex: ${hex}`);
    return {};
  }

  console.log(`[AI Meta Viewer] extractMetadata: format detected: ${format}, buffer size: ${buffer.byteLength}`);

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
