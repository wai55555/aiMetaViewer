// adapters.js - Site-specific image URL resolvers

// --- サイト別アダプター ---
window.SiteAdapters = [
    // Discord
    {
        match: () => window.location.hostname.includes('discord.com'),
        resolve: (img) => {
            // 1. 親リンクからの判定 (cdn.discordapp.com)
            const parentLink = img.closest('a');
            if (parentLink && parentLink.href) {
                const href = parentLink.href;
                if (href.includes('cdn.discordapp.com') && parentLink.className.includes('originalLink')) {
                    return href;
                }
            }

            // 2. ネストされた構造からの判定
            let container = img.closest('[class*="imageWrapper"]');
            if (!container) {
                let parent = img.parentElement;
                for (let i = 0; i < 4; i++) {
                    if (!parent) break;
                    if (parent.querySelector('a[class*="originalLink"]')) {
                        container = parent;
                        break;
                    }
                    parent = parent.parentElement;
                }
            }

            if (container) {
                const discordLink = container.querySelector('a[class*="originalLink"]');
                if (discordLink && discordLink.href && discordLink.href.includes('cdn.discordapp.com')) {
                    return discordLink.href;
                }
            }
            return null;
        }
    },
    // Pixiv
    {
        match: () => window.location.hostname.includes('pixiv.net'),
        resolve: (img) => {
            // 1. 既存の img-original リンクチェック
            const parentLink = img.closest('a');
            if (parentLink && parentLink.href && parentLink.href.includes('img-original')) {
                return parentLink.href;
            }

            // 2. サムネイルからオリジナルURLを推測
            // 対応: ギャラリー (_square1200), ランキング (_master1200), その他サムネイル
            const src = img.src;
            if (src.includes('i.pximg.net') && (src.includes('img-master') || src.includes('custom-thumb'))) {
                // URL変換ロジック
                // 例1 (ギャラリー): https://i.pximg.net/c/250x250.../img-master/.../123_p0_square1200.jpg
                // 例2 (ランキング): https://i.pximg.net/c/480x960/img-master/.../123_p0_master1200.jpg
                // -> https://i.pximg.net/img-original/.../123_p0.png

                try {
                    const url = new URL(src);
                    let pathname = url.pathname;

                    // /c/xxx/ 部分を削除
                    pathname = pathname.replace(/^\/c\/[^/]+\//, '/');

                    // img-master または custom-thumb を img-original に置換
                    pathname = pathname.replace(/\/(img-master|custom-thumb)\//, '/img-original/');

                    // ファイル名から _square1200, _master1200 などのサフィックスを削除
                    // 例: 136040914_p0_square1200.jpg -> 136040914_p0
                    const match = pathname.match(/^(.+\/)(\d+_p\d+).*\.(jpg|png|webp|gif)$/);
                    if (match) {
                        const basePath = match[1]; // /img-original/img/2025/10/09/00/42/23/
                        const fileBase = match[2]; // 136040914_p0

                        // 拡張子候補: .png, .jpg, .webp の順で試行
                        const candidates = [
                            `${url.origin}${basePath}${fileBase}.png`,
                            `${url.origin}${basePath}${fileBase}.jpg`,
                            `${url.origin}${basePath}${fileBase}.webp`
                        ];

                        return candidates; // 配列を返す
                    }
                } catch (e) {
                    // URL解析失敗時は null
                }
            }

            return null;
        }
    },
    // 汎用 (拡張子チェック)
    {
        match: () => true, // 常にマッチ
        resolve: (img) => {
            const parentLink = img.closest('a');
            if (parentLink && parentLink.href) {
                const href = parentLink.href;
                const cleanHref = href.split('?')[0];
                if (/\.(png|jpg|jpeg|webp|avif)$/i.test(cleanHref)) {
                    return href;
                }
            }
            return null;
        }
    }
];
