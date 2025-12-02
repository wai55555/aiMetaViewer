// background.js - Background Service Worker

// メタデータキャッシュ (URLごと)
const metadataCache = new Map();

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
});

/**
 * 画像を取得してメタデータを抽出
 * @param {string} imageUrl - 画像URL
 * @param {string} [base64Data] - Base64エンコードされた画像データ（オプション）
 * @returns {Promise<Object>} - { success: boolean, metadata?: Object, error?: string }
 */
async function handleFetchImageMetadata(imageUrl, base64Data = null) {
    console.log('[AI Meta Viewer] Fetching metadata for:', imageUrl);

    // キャッシュチェック
    if (metadataCache.has(imageUrl)) {
        const cachedMetadata = metadataCache.get(imageUrl);
        console.log('[AI Meta Viewer] Cache hit:', imageUrl);
        return { success: true, metadata: cachedMetadata, cached: true };
    }

    try {
        let buffer;

        if (base64Data) {
            // Base64データが提供されている場合（ローカルファイルなど）
            console.log('[AI Meta Viewer] Using provided Base64 data');
            const response = await fetch(base64Data);
            buffer = await response.arrayBuffer();
        } else {
            // 通常のURLフェッチ
            const response = await fetch(imageUrl);

            if (!response.ok) {
                console.error('[AI Meta Viewer] Fetch failed:', response.status);
                return { success: false, error: `HTTP ${response.status}` };
            }

            buffer = await response.arrayBuffer();
        }

        console.log('[AI Meta Viewer] Image loaded, size:', buffer.byteLength, 'bytes');

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
        console.log('[AI Meta Viewer] Extracted metadata:', metadata);
        console.log('[AI Meta Viewer] Metadata keys:', Object.keys(metadata).length);

        // 段階3 & 4: PNG判定 & αチャンネル解析
        const format = detectImageFormat(buffer);
        console.log('[AI Meta Viewer] Detected format:', format);

        if (format === 'png') {
            const hasAlpha = checkPngIHDRHasAlpha(buffer);
            console.log('[AI Meta Viewer] Has Alpha:', hasAlpha);

            // 既存メタデータがない、またはαチャンネル解析を強制する場合（デバッグ用）
            // 現状は「既存メタデータがない場合のみ」
            if (Object.keys(metadata).length === 0) {
                if (hasAlpha) {
                    console.log('[AI Meta Viewer] Starting Stealth PNG Info extraction...');
                    const stealthData = await extractStealthPNGInfoAsync(imageUrl, buffer);
                    console.log('[AI Meta Viewer] Stealth Data result:', stealthData);

                    if (stealthData) {
                        Object.assign(metadata, stealthData);
                    }
                } else {
                    console.log('[AI Meta Viewer] Skipping Stealth Info: No Alpha channel');
                }
            } else {
                console.log('[AI Meta Viewer] Skipping Stealth Info: Metadata already exists');
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
 * Stealth PNG Info を非同期で抽出（createImageBitmap使用）
 * @param {string} imageUrl - 画像URL
 * @param {ArrayBuffer} buffer - 画像バイナリデータ
 * @returns {Promise<Object|null>} - 抽出されたメタデータ
 */
async function extractStealthPNGInfoAsync(imageUrl, buffer) {
    try {
        // Blob作成
        const blob = new Blob([buffer], { type: 'image/png' });

        // createImageBitmap で画像をデコード (Service Workerで利用可能)
        const imageBitmap = await createImageBitmap(blob);

        const width = imageBitmap.width;
        const height = imageBitmap.height;

        // 250000画素未満はスキップ(段階1はcontent.jsで既に実施されているが念のため)
        if (width * height < 250000) {
            imageBitmap.close();
            return null;
        }

        // OffscreenCanvas でピクセルデータ取得
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0);

        // ImageData取得
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;

        // ビットストリーム構築（Alpha と RGB）
        // 文字列連結は低速なため配列を使用
        const alphaBits = [];
        const rgbBits = [];

        // 全ピクセルスキャン（x→y順: 元の実装仕様を維持）
        // 注意: 一般的な画像処理はy→x順だが、Stealth PNG Infoの仕様に合わせてx→y順としている可能性を考慮
        for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
                const i = (y * width + x) * 4;
                // RGB各チャンネルのLSB（最下位ビット）を抽出
                rgbBits.push(data[i] & 1);
                rgbBits.push(data[i + 1] & 1);
                rgbBits.push(data[i + 2] & 1);

                // AlphaチャンネルのLSBを抽出
                alphaBits.push(data[i + 3] & 1);
            }
        }

        const bitStreamAlpha = alphaBits.join('');
        const bitStreamRGB = rgbBits.join('');

        // デコード試行 (Alpha → RGB の順)
        const resultAlpha = processStealthStream(bitStreamAlpha, 'Alpha');
        const resultRGB = processStealthStream(bitStreamRGB, 'RGB');

        imageBitmap.close();

        // 結果をメタデータ形式で返す
        const stealthMetadata = {};

        if (resultAlpha && resultAlpha.data && !resultAlpha.data.startsWith('[')) {
            // Alphaチャンネルからデータ発見
            stealthMetadata['Stealth PNG Info (Alpha)'] = resultAlpha.data;
        }

        if (resultRGB && resultRGB.data && !resultRGB.data.startsWith('[')) {
            // RGBチャンネルからデータ発見
            stealthMetadata['Stealth PNG Info (RGB)'] = resultRGB.data;
        }

        return Object.keys(stealthMetadata).length > 0 ? stealthMetadata : null;

    } catch (error) {
        console.error('Stealth PNG Info extraction error:', error);
        return null;
    }
}

// Service Worker起動時にライブラリを読み込む
importScripts('pako.js');
importScripts('parser.js');
