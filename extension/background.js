// background.js - Background Service Worker

// 永続化LRUキャッシュクラス (chrome.storage.local使用)
class PersistentLRUCache {
    constructor(limit = 2000) {
        this.limit = limit;
        this.storage = chrome.storage.local;
        this.cacheKeyPrefix = 'meta_cache_';
        this.metaKey = 'meta_cache_index'; // キー一覧とタイムスタンプを管理
        this.lastCleanUp = 0;

        // メモリ内インデックス: Map<Url, Timestamp>
        // 頻繁なストレージアクセスを減らすため、キーと最終アクセス時刻はメモリにも持つ
        this.index = new Map();

        // initを待機可能にするためPromiseを保持
        this.initPromise = this.init();
    }

    async init() {
        try {
            const result = await this.storage.get(this.metaKey);
            if (result[this.metaKey]) {
                // 配列からMapへ復元: [[url, timestamp], ...]
                this.index = new Map(result[this.metaKey]);
            }
        } catch (e) {
            console.error('Cache init error:', e);
        }
    }

    async saveIndex() {
        try {
            // Mapを配列に変換して保存
            await this.storage.set({ [this.metaKey]: Array.from(this.index.entries()) });
        } catch (e) {
            console.error('Cache index save error:', e);
        }
    }

    async get(url) {
        await this.initPromise;
        if (!this.index.has(url)) return undefined;

        // アクセス日時更新 (メモリ)
        this.index.delete(url);
        this.index.set(url, Date.now());
        // インデックス保存は頻繁すぎるので、一定間隔または重要なタイミングで行うか、
        // ここでは簡易的に都度保存はしない（終了時フックがないので定期保存が理想だが）
        // 今回はset時にまとめて保存する戦略をとる

        const key = this.cacheKeyPrefix + url;
        try {
            const result = await this.storage.get(key);
            return result[key];
        } catch (e) {
            console.error('Cache get error:', e);
            return undefined;
        }
    }

    async set(url, metadata) {
        await this.initPromise;
        const key = this.cacheKeyPrefix + url;
        const timestamp = Date.now();

        // メモリインデックス更新
        if (this.index.has(url)) this.index.delete(url);
        this.index.set(url, timestamp);

        try {
            // ストレージ容量チェック & 掃除
            await this.ensureCapacity();

            await this.storage.set({ [key]: metadata });
            await this.saveIndex();
        } catch (e) {
            console.error('Cache set error:', e);
            // クォータエラーなどが起きた場合、さらに掃除して再試行すべきだが、一旦ログのみ
        }
    }

    async has(url) {
        await this.initPromise;
        return this.index.has(url);
    }

    async clear() {
        await this.initPromise;
        await this.storage.clear();
        this.index.clear();
    }

    async ensureCapacity() {
        // 定期クリーンアップ (例えば set 50回に1回、または容量チェックエラー時)
        // ここでは簡易的に、項目数が limit を超えたら古いものを消す
        if (this.index.size > this.limit) {
            const deleteCount = Math.ceil(this.limit * 0.1); // 10% 削除
            const sorted = Array.from(this.index.entries()).sort((a, b) => a[1] - b[1]); // 古い順

            const keysToRemove = [];
            const urlsToRemove = [];

            for (let i = 0; i < deleteCount; i++) {
                if (i >= sorted.length) break;
                const [url, _] = sorted[i];
                urlsToRemove.push(url);
                keysToRemove.push(this.cacheKeyPrefix + url);
                this.index.delete(url);
            }

            if (keysToRemove.length > 0) {
                console.log(`[Cache] Evicting ${keysToRemove.length} items`);
                await this.storage.remove(keysToRemove);
                // インデックスは saveIndex で更新される
            }
        }

        // 本当は getBytesInUse を見て 4MB 超えたら消す処理も入れたい
        // しかし getBytesInUse は非同期でコストがかかるため、項目数制限をメインガードとする
    }
}

// 永続キャッシュインスタンス
const metadataCache = new PersistentLRUCache(2000);

// Range Request 失敗ドメインリスト (メモリ保持)
const rangeRequestBlockList = new Set();


// ダウンロード先パスを一時的に保持するマップ（URL -> ファイルパスのキュー）
const downloadPathQueue = new Map();

// ファイル名の決定を上書きするリスナー
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const queue = downloadPathQueue.get(item.url);
    if (queue && queue.length > 0) {
        const targetFilename = queue.shift();
        if (queue.length === 0) downloadPathQueue.delete(item.url);

        debugLog('[AI Meta Viewer] Forcing filename via Event:', targetFilename);
        suggest({
            filename: targetFilename,
            conflictAction: 'uniquify'
        });
    }
});

// デフォルト設定
const DEFAULT_SETTINGS = {
    debugMode: false,
    errorNotification: false,
    minPixelCount: 250000,
    downloaderFolderMode: 'pageTitle', // 'pageTitle', 'domain', 'none'
    downloaderBaseFolder: 'AI_Meta_Viewer',
    downloaderUseRoot: false
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
        metadataCache.clear().then(() => {
            debugLog('[AI Meta Viewer] Cache cleared');
            sendResponse({ success: true });
        });
        return true;
    }

    if (request.action === 'downloadImages') {
        const folderContext = request.context || { folderName: request.folderName };
        handleDownloadImages(request.images, folderContext)
            .then(count => sendResponse({ success: true, count }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }
});

/**
 * 拡張機能アイコンがクリックされた時の処理
 */
chrome.action.onClicked.addListener((tab) => {
    debugLog('[AI Meta Viewer] Extension icon clicked on tab:', tab.id);
    chrome.tabs.sendMessage(tab.id, { action: 'triggerScan' }).catch(err => {
        console.error('[AI Meta Viewer] Failed to send triggerScan message:', err);
    });
});

/**
 * 画像リストを一括ダウンロード
 */
async function handleDownloadImages(images, context) {
    const { pageTitle, domain } = context || {};
    debugLog('[AI Meta Viewer] Starting download loop. Images:', images.length);

    // フォルダ・ファイル名に使用できない文字のサニタイズ (Windows/macOS/Linux共通)
    const sanitize = (str) => {
        if (!str) return '';
        return str
            .replace(/[\\/:*?"<>|]/g, '_') // Windows基本禁止文字
            .replace(/^\.+|\.+$/g, '_')    // 先頭・末尾のドットを '_' に (Windowsフォルダ制限)
            .trim();
    };

    let downloadPath = '';
    // ルート保存設定がオフの場合のみメインフォルダを作成
    if (!settings.downloaderUseRoot) {
        const base = sanitize(settings.downloaderBaseFolder || 'AI_Meta_Viewer');
        if (base && base !== '_') {
            downloadPath = base;
        }
    }

    let subFolder = '';

    if (settings.downloaderFolderMode === 'pageTitle' && pageTitle) {
        subFolder = sanitize(pageTitle).substring(0, 22); // ユーザー指定の22文字制限を維持
    } else if (settings.downloaderFolderMode === 'domain' && domain) {
        subFolder = sanitize(domain);
    }

    if (subFolder) {
        if (downloadPath) {
            downloadPath += `/${subFolder}`;
        } else {
            downloadPath = subFolder;
        }
    }

    // どちらも空の場合はファイル名のみ（ダウンロード直下）
    if (!downloadPath) {
        console.log('[AI Meta Viewer] Saving directly to Downloads root');
    } else {
        console.log('[AI Meta Viewer] Final download directory (relative to Downloads):', downloadPath);
    }

    let downloadedCount = 0;
    for (const img of images) {
        try {
            let safeFilename = sanitize(img.filename);
            if (!safeFilename || safeFilename === '_') {
                safeFilename = `image_${Date.now()}_${downloadedCount}.png`;
            }

            const fullFilename = downloadPath ? `${downloadPath}/${safeFilename}` : safeFilename;
            debugLog('[AI Meta Viewer] Registering path & Requesting download:', fullFilename);

            // イベントリスナー用にキューへパスを登録
            if (!downloadPathQueue.has(img.url)) {
                downloadPathQueue.set(img.url, []);
            }
            downloadPathQueue.get(img.url).push(fullFilename);

            chrome.downloads.download({
                url: img.url,
                filename: fullFilename,
                conflictAction: 'uniquify',
                saveAs: false
            }, (downloadId) => {
                if (chrome.runtime.lastError) {
                    console.error(`[AI Meta Viewer] API Error for ${fullFilename}:`, chrome.runtime.lastError.message);
                    // 失敗した場合はキューから削除を試みる
                    const q = downloadPathQueue.get(img.url);
                    if (q) {
                        q.shift();
                        if (q.length === 0) downloadPathQueue.delete(img.url);
                    }
                } else {
                    debugLog(`[AI Meta Viewer] Download started with ID: ${downloadId}`);
                }
            });

            downloadedCount++;
        } catch (e) {
            console.error(`[AI Meta Viewer] Catch block error for ${img.url}:`, e);
        }
    }

    return downloadedCount;
}


/**
 * 画像を取得してメタデータを抽出
 * Adaptive Range Request Logic 実装
 */
async function handleFetchImageMetadata(imageUrl, base64Data = null) {
    debugLog('[AI Meta Viewer] Fetching metadata for:', imageUrl);

    // 1. キャッシュチェック (Async)
    const cachedMetadata = await metadataCache.get(imageUrl);
    if (cachedMetadata !== undefined) {
        debugLog('[AI Meta Viewer] Persistent Cache hit:', imageUrl);
        // キャッシュされた結果が「空オブジェクト」ならネガティブキャッシュヒット、あればポジティブヒット
        // ここでは空でも返す(スキャナー側で判断)
        return { success: true, metadata: cachedMetadata, cached: true };
    }

    // parser.js チェック
    if (typeof extractMetadata !== 'function') {
        return { success: false, error: 'Parser not loaded' };
    }

    try {
        let buffer;
        let isRangeRequest = false;

        if (base64Data) {
            // Base64データが提供されている場合（ローカルファイルなど）
            debugLog('[AI Meta Viewer] Using provided Base64 data');
            const response = await fetch(base64Data);
            buffer = await response.arrayBuffer();
        } else {
            // URLフェッチ: Range Request 試行
            // ドメインチェック
            let domain = '';
            try { domain = new URL(imageUrl).hostname; } catch (e) { }

            const shouldUseRange = !rangeRequestBlockList.has(domain);

            if (shouldUseRange) {
                try {
                    // 先頭 64KB をリクエスト
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5秒タイムアウト

                    const response = await fetch(imageUrl, {
                        headers: { 'Range': 'bytes=0-65535' },
                        signal: controller.signal
                    });
                    clearTimeout(timeoutId);

                    if (response.status === 206) {
                        // Range成功
                        isRangeRequest = true;
                        buffer = await response.arrayBuffer();
                        debugLog('[AI Meta Viewer] Range request success (0-65535)');
                    } else if (response.status === 200) {
                        // サーバーがRange無視して全データ返してきた
                        debugLog('[AI Meta Viewer] Server ignored Range, received full content');
                        buffer = await response.arrayBuffer();
                        // ブロックはしない（害はないため）
                    } else {
                        // 403, 400, 416 等 -> Range不可とみなす
                        throw new Error(`Range request failed with status ${response.status}`);
                    }

                } catch (e) {
                    debugLog('[AI Meta Viewer] Range request failed or aborted:', e.message);
                    // ドメインをブロックリストへ
                    if (domain) {
                        rangeRequestBlockList.add(domain);
                        debugLog(`[AI Meta Viewer] Added ${domain} to Range Blocklist`);
                    }
                    // フォールバック: 全取得
                    const fbResponse = await fetch(imageUrl);
                    if (!fbResponse.ok) throw new Error(`Fallback HTTP ${fbResponse.status}`);
                    buffer = await fbResponse.arrayBuffer();
                }
            } else {
                // 最初から Range 不可ドメイン
                debugLog('[AI Meta Viewer] Skipping Range for blocked domain, fetching full...');
                const response = await fetch(imageUrl);
                if (!response.ok) return { success: false, error: `HTTP ${response.status}` };
                buffer = await response.arrayBuffer();
            }
        }

        // --- メタデータ解析 ---
        // Range Requestの場合、ファイルが不完全なので、パーサーがエラーを吐く可能性がある
        // または、末尾にデータがある場合（PNGのtEXtが最後にある、StealthInfoが最後にあるなど）は見逃す

        let metadata = {};
        try {
            metadata = extractMetadata(buffer);
        } catch (e) {
            // 解析エラーが出た場合、かつRangeRequestだった場合は、不完全データが原因かもしれないので全取得リトライ
            if (isRangeRequest) {
                debugLog('[AI Meta Viewer] Parse error on partial data, retrying full fetch...');
                const fullResp = await fetch(imageUrl);
                const fullBuffer = await fullResp.arrayBuffer();
                buffer = fullBuffer; // バッファを更新
                metadata = extractMetadata(buffer);
                isRangeRequest = false; // フラグ解除
            } else {
                throw e; // 全データでもダメなら諦める
            }
        }

        debugLog('[AI Meta Viewer] Extracted metadata:', metadata);

        // Stealth PNG Info チェック (常に全データが必要)
        // Range Requestで取得した64KBだけでは、画像サイズチェックや画素読み取りができない（不整合が起きる）
        // または、Stealth Infoは画像のピクセルデータ全体に散らばっているため、全取得必須。
        // -> メタデータが見つからず、かつPNGの場合で、Range取得だった場合は、結局全取得が必要になる可能性がある。

        // 戦略:
        // 通常のメタデータがあれば、Stealth Infoは見にいかない（既存ロジック通り）。
        // メタデータが無い場合のみ Stealth Info を見る。
        // -> なので、Rangeでメタデータが見つかれば高速化成功。無ければ全取得してStealthチェックへ。

        if (Object.keys(metadata).length === 0) {
            const format = detectImageFormat(buffer);
            if (format === 'png') {
                // RangeデータだけでStealth解析はできないので、Rangeだった場合は全取得してから挑む
                if (isRangeRequest) {
                    debugLog('[AI Meta Viewer] No standard metadata in partial data. Downloading full image for Stealth Info check...');
                    const fullResp = await fetch(imageUrl);
                    if (fullResp.ok) {
                        buffer = await fullResp.arrayBuffer(); // バッファ置き換え
                    }
                }

                const hasAlpha = checkPngIHDRHasAlpha(buffer);
                if (hasAlpha) {
                    const stealthData = await extractStealthPNGInfoAsync(imageUrl, buffer);
                    if (stealthData) {
                        Object.assign(metadata, stealthData);
                    }
                }
            }
        }

        // Cache Result (Empty or Not)
        // ここで保存。次回からは通信なし。
        await metadataCache.set(imageUrl, metadata);

        return { success: true, metadata: metadata };

    } catch (error) {
        return { success: false, error: error.message };
    }
}

/**
 * Stealth PNG Info を非同期で抽出
 */
async function extractStealthPNGInfoAsync(imageUrl, buffer) {
    try {
        const blob = new Blob([buffer], { type: 'image/png' });
        // createImageBitmap は壊れた（部分的な）PNGデータだと失敗する可能性がある
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

        // Alphaチャンネルのシグネチャチェック
        const sigLength = 15; // "stealth_pnginfo".length
        const sigBitsNeeded = sigLength * 8;
        let alphaSig = "";
        for (let i = 0; i < sigBitsNeeded; i++) {
            alphaSig += (data[i * 4 + 3] & 1);
        }

        const targetSig = "011100110111010001100101011000010110110001110100011010000101111101110000011011100110011101101001011011100110011001101111";

        if (alphaSig === targetSig) {
            debugLog('[AI Meta Viewer] Alpha signature match! Extracting full data...');
            const totalPixels = width * height;
            const alphaBits = new Uint8Array(totalPixels);

            for (let i = 0; i < totalPixels; i++) {
                alphaBits[i] = data[i * 4 + 3] & 1;
            }

            const bitStreamAlpha = Array.from(alphaBits).join('');
            const resultAlpha = processStealthStream(bitStreamAlpha, 'Alpha');
            if (resultAlpha && resultAlpha.data) {
                return { 'Stealth PNG Info (Alpha)': resultAlpha.data };
            }
        }

        // RGBチェック (省略または必要なら実装、今回はAlphaのみで高速化重視)
        return null;

    } catch (error) {
        // console.error('Stealth PNG Info extraction error:', error);
        return null;
    }
}

// Service Worker起動時にライブラリを読み込む
importScripts('pako.js');
importScripts('parser.js');
