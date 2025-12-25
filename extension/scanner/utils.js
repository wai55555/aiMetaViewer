// scanner/utils.js - ユーティリティ関数

/**
 * URLからファイル名を推測
 */
function getFilenameFromUrl(urlStr) {
    try {
        const url = new URL(urlStr);
        const pathname = url.pathname;
        const filename = pathname.split('/').pop();
        return filename || 'file';
    } catch (e) {
        return 'file';
    }
}

/**
 * ファイル名からメディアタイプを判定
 * 複合拡張子(tar.gz等)にも対応
 * @param {string} filename 
 * @returns {string} 'image' | 'video' | 'audio' | 'archive' | 'unknown'
 */
function getMediaType(filename) {
    const lower = filename.toLowerCase();

    // 複合拡張子チェック（先に確認）
    if (/\.(tar\.gz|tar\.bz2|tar\.xz|tgz|tbz2)$/i.test(lower)) return 'archive';

    // 単一拡張子チェック
    const mediaTypes = {
        image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'avif'],
        video: ['mp4', 'webm', 'mkv', 'avi', 'flv', 'mov', 'wmv', 'mpg', 'mpeg', 'm4v'],
        audio: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus'],
        archive: ['zip', 'rar', '7z', 'lzh', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz', 'tgz', 'tbz2', 'gz', 'bz2', 'xz', 'safetensors', 'ckpt', 'pt']
    };

    for (const [type, exts] of Object.entries(mediaTypes)) {
        if (exts.some(ext => lower.endsWith('.' + ext))) {
            return type;
        }
    }

    return 'unknown';
}

/**
 * バイト数を読みやすい形式に変換
 */
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
