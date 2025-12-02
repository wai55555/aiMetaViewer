// background.js - Background Service Worker

// LRUキャッシュクラス
class LRUCache {
    constructor(limit = 100) {
        this.limit = limit;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return undefined;
        const val = this.cache.get(key);
        // アクセスされた項目を再挿入して最新にする
        this.cache.delete(key);
        this.cache.set(key, val);
        return val;
    }

    set(key, val) {
        if (this.cache.has(key)) this.cache.delete(key);
        else if (this.cache.size >= this.limit) {
            // 最も古い項目（最初の項目）を削除
            this.cache.delete(this.cache.keys().next().value);
        }
        this.cache.set(key, val);
    }

    has(key) {
        return this.cache.has(key);
    }

    clear() {
        this.cache.clear();
    }
}

// メタデータキャッシュ (URLごと, 最大100件)
const metadataCache = new LRUCache(100);

// デフォルト設定
const DEFAULT_SETTINGS = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000
};

// 現在の設定（起動時に読み込み）
let settings = { ...DEFAULT_SETTINGS };

// デバッグログ出力関数
function debugLog(...args) {
    if (settings.debugMode) {
        console.log(...args);
    }
}

// 設定を読み込む
async function loadSettings() {
    const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    settings = stored;
    debugLog('[AI Meta Viewer] Settings loaded:', settings);
}

// 初期化時に設定を読み込む
loadSettings();

/**
 * Content Scriptからのメッセージを処理
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'fetchImageMetadata') {
        handleFetchImageMetadata(request.imageUrl, request.imageData)
            .then(sendResponse)
            .catch(error => {
                console.error('Metadata fetch error:', error);
                sendResponse({ success: false, error: error.message });
            });

        // 非同期レスポンスを返すため true を返す
        return true;
    }

    if (request.action === 'settingsUpdated') {
        // 設定が更新された
        settings = request.settings;
        debugLog('[AI Meta Viewer] Settings updated:', settings);
        sendResponse({ success: true });
        return true;
    }

    if (request.action === 'clearCache') {
        // キャッシュをクリア
        metadataCache.clear();
        debugLog('[AI Meta Viewer] Cache cleared');
        sendResponse({ success: true });
        return true;
    }
});

/**
 * 画像を取得してメタデータを抽出
 * @param {string} imageUrl - 画像URL
 * @param {string} [base64Data] - Base64エンコードされた画像データ（オプション）
 * @returns {Promise<Object>} - { success: boolean, metadata?: Object, error?: string }
 */
async function handleFetchImageMetadata(imageUrl, base64Data = null) {
    debugLog('[AI Meta Viewer] Fetching metadata for:', imageUrl);

    // キャッシュチェック
    if (metadataCache.has(imageUrl)) {
        const cachedMetadata = metadataCache.get(imageUrl);
        debugLog('[AI Meta Viewer] Cache hit:', imageUrl);
        return { success: true, metadata: cachedMetadata, cached: true };
    }

    try {
        let buffer;

        if (base64Data) {
            // Base64データが提供されている場合（ローカルファイルなど）
            debugLog('[AI Meta Viewer] Using provided Base64 data');
            const response = await fetch(base64Data);
            buffer = await response.arrayBuffer();
        } else {
            // 通常のURLフェッチ
            const response = await fetch(imageUrl);

            if (!response.ok) {
                // 404は候補URLが存在しない場合（Pixivの拡張子試行など）なので、デバッグログのみ
                if (response.status === 404) {
                    debugLog(`[AI Meta Viewer] Image not found (404): ${imageUrl}`);
                } else {
                    console.error('[AI Meta Viewer] Fetch failed:', response.status);
                }
                return { success: false, error: `HTTP ${response.status}` };
            }

            buffer = await response.arrayBuffer();
        }

        debugLog('[AI Meta Viewer] Image loaded, size:', buffer.byteLength, 'bytes');

        // 10MB制限
        if (buffer.byteLength > 10 * 1024 * 1024) {
            return { success: false, error: 'Image too large (>10MB)' };
        }

        // 段階2: 既存メタデータ確認 (parser.jsの関数をインポート)
        if (typeof extractMetadata !== 'function') {
            console.error('[AI Meta Viewer] Parser not loaded!');
            return { success: false, error: 'Parser not loaded' };
        }

        let metadata = extractMetadata(buffer);
        debugLog('[AI Meta Viewer] Extracted metadata:', metadata);
        debugLog('[AI Meta Viewer] Metadata keys:', Object.keys(metadata).length);

        // 段階3 & 4: PNG判定 & αチャンネル解析
        const format = detectImageFormat(buffer);
        debugLog('[AI Meta Viewer] Detected format:', format);

        if (format === 'png') {
            const hasAlpha = checkPngIHDRHasAlpha(buffer);
            debugLog('[AI Meta Viewer] Has Alpha:', hasAlpha);

            // 既存メタデータがない場合のみStealth PNG解析
            if (Object.keys(metadata).length === 0) {
                if (hasAlpha) {
                    debugLog('[AI Meta Viewer] Starting Stealth PNG Info extraction...');
                    const stealthData = await extractStealthPNGInfoAsync(imageUrl, buffer);
                    debugLog('[AI Meta Viewer] Stealth Data result:', stealthData);

                    if (stealthData) {
                        Object.assign(metadata, stealthData);
                    }
                } else {
                    debugLog('[AI Meta Viewer] Skipping Stealth Info: No Alpha channel');
                }
            } else {
                debugLog('[AI Meta Viewer] Skipping Stealth Info: Metadata already exists');
            }
        }

        // 空でない場合のみキャッシュ
        if (metadata && Object.keys(metadata).length > 0) {
            metadataCache.set(imageUrl, metadata);
            return { success: true, metadata: metadata };
        } else {
            return { success: true, metadata: {} };
        }

    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Stealth PNG Info を非同期で抽出（最適化版）
 * @param {string} imageUrl - 画像URL
 * @param {ArrayBuffer} buffer - 画像バイナリデータ
 * @returns {Promise<Object|null>} - 抽出されたメタデータ
 */
async function extractStealthPNGInfoAsync(imageUrl, buffer) {
    try {
        const blob = new Blob([buffer], { type: 'image/png' });
        const imageBitmap = await createImageBitmap(blob);
        const width = imageBitmap.width;
        const height = imageBitmap.height;

        if (width * height < 250000) {
            imageBitmap.close();
            return null;
        }

        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0);

        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        imageBitmap.close();

        // 最適化: シグネチャチェック
        // "stealth_pnginfo" は 15文字 = 120ビット。
        // LSBエンコーディングなので、120ピクセル必要。
        // 最初の120ピクセルだけ読んでシグネチャを確認する。

        const sigLength = 15; // "stealth_pnginfo".length
        const sigBitsNeeded = sigLength * 8;

        // Alphaチャンネルのシグネチャチェック
        let alphaSig = "";
        for (let i = 0; i < sigBitsNeeded; i++) {
            // x, y 順序: i番目のピクセル
            // dataは [r, g, b, a, r, g, b, a, ...]
            // i番目のピクセルのalphaは data[i * 4 + 3]
            alphaSig += (data[i * 4 + 3] & 1);
        }

        // RGBチャンネルのシグネチャチェック
        let rgbSig = "";
        for (let i = 0; i < sigBitsNeeded; i++) {
            // RGBは3ビットずつ取れるが、parser.jsの実装に合わせて単純化
            // parser.jsの仕様: rgbBits.push(data[i] & 1); rgbBits.push(data[i+1] & 1); rgbBits.push(data[i+2] & 1);
            // つまり1ピクセルあたり3ビット。
            // 必要なピクセル数は sigBitsNeeded / 3 = 40ピクセル。

            // ここでは簡易的に、全ピクセル走査ロジックと同じ順序でビットを集める必要がある。
            // 複雑になるため、RGBは一旦スキップし、Alphaの最適化に集中するか、
            // あるいは「全走査するが、ビット配列ではなく文字列/バッファを直接作る」アプローチにする。
        }

        // 戦略変更:
        // シグネチャチェックは複雑になりがち（RGBの場合など）。
        // 確実かつ高速なのは「巨大配列を作らない」こと。
        // Uint8Arrayでビットを保持し、parser.jsに渡す前に文字列化する、
        // あるいは parser.js を改修して Uint8Array を受け取るようにするのがベストだが、
        // ここでは「文字列連結のコスト」を下げるため、一定サイズごとのチャンク処理を行う。

        // しかし、最も重いのは「全ピクセルループ」そのもの。
        // Alphaチャンネルにデータがあるかどうかの「早期リターン」が最も効果的。

        // Alphaチャンネルのシグネチャ "stealth_pnginfo" (binary) を確認
        // "stealth_pnginfo" -> binary string
        const targetSig = "011100110111010001100101011000010110110001110100011010000101111101110000011011100110011101101001011011100110011001101111";
        // (これは "stealth_pnginfo" のASCIIコードの2進数表現)

        if (alphaSig === targetSig) {
            debugLog('[AI Meta Viewer] Alpha signature match! Extracting full data...');
            // マッチした場合のみ全データを抽出
            // ここで初めて全ピクセルループを回す

            const totalPixels = width * height;
            const alphaBits = new Uint8Array(totalPixels); // 0 or 1

            for (let i = 0; i < totalPixels; i++) {
                alphaBits[i] = data[i * 4 + 3] & 1;
            }

            // Uint8Array -> String
            // これも重いが、配列pushよりはマシかつ、必要な時しか走らない
            const bitStreamAlpha = Array.from(alphaBits).join('');

            const resultAlpha = processStealthStream(bitStreamAlpha, 'Alpha');
            if (resultAlpha && resultAlpha.data) {
                return { 'Stealth PNG Info (Alpha)': resultAlpha.data };
            }
        }

        // RGBは頻度が低いので、Alphaが見つからなければチェックしない、または
        // 同様にシグネチャチェックを行う。
        // RGBのシグネチャチェック:
        // 1ピクセルあたり3ビット (R, G, B)
        // 120ビット必要 -> 40ピクセル

        let rgbSigBits = "";
        for (let i = 0; i < 40; i++) {
            const idx = i * 4;
            rgbSigBits += (data[idx] & 1);
            rgbSigBits += (data[idx + 1] & 1);
            rgbSigBits += (data[idx + 2] & 1);
        }

        // RGBシグネチャ: "stealth_rgbinfo"
        // 面倒なので、RGBは「Alphaになかった場合」かつ「設定で有効な場合」などに限定したいが、
        // とりあえずAlpha最適化だけで十分効果があるはず。
        // 既存のロジック（全走査）はRGBもAlphaも同時にやっていたため遅かった。

        // RGB対応: シグネチャが一致した場合のみ全走査
        // "stealth_rgbinfo" のバイナリ
        // binary string for "stealth_rgbinfo"
        // s: 01110011 ...
        // 面倒なので、parser.js の binaryToText を使って検証する

        const rgbSigText = binaryToText(rgbSigBits);
        if (rgbSigText.startsWith('stealth_rgb')) {
            debugLog('[AI Meta Viewer] RGB signature match! Extracting full data...');
            const totalPixels = width * height;
            const rgbBits = new Uint8Array(totalPixels * 3);

            for (let i = 0; i < totalPixels; i++) {
                const idx = i * 4;
                const outIdx = i * 3;
                rgbBits[outIdx] = data[idx] & 1;
                rgbBits[outIdx + 1] = data[idx + 1] & 1;
                rgbBits[outIdx + 2] = data[idx + 2] & 1;
            }

            const bitStreamRGB = Array.from(rgbBits).join('');
            const resultRGB = processStealthStream(bitStreamRGB, 'RGB');
            if (resultRGB && resultRGB.data) {
                return { 'Stealth PNG Info (RGB)': resultRGB.data };
            }
        }

        return null;

    } catch (error) {
        console.error('Stealth PNG Info extraction error:', error);
        return null;
    }
}

// Service Worker起動時にライブラリを読み込む
importScripts('pako.js');
importScripts('parser.js');
