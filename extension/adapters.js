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
        },
        deepScan: () => null,
        getBadgeTargets: () => null
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
            const src = img.src || img.currentSrc;
            if (src.includes('i.pximg.net') && (src.includes('img-master') || src.includes('custom-thumb'))) {
                try {
                    const url = new URL(src);
                    let pathname = url.pathname;
                    pathname = pathname.replace(/^\/c\/[^/]+\//, '/');
                    pathname = pathname.replace(/\/(img-master|custom-thumb)\//, '/img-original/');

                    const match = pathname.match(/^(.+\/)(\d+_p\d+).*\.(jpg|png|webp|gif)$/);
                    if (match) {
                        const basePath = match[1];
                        const fileBase = match[2];

                        return [
                            `${url.origin}${basePath}${fileBase}.png`,
                            `${url.origin}${basePath}${fileBase}.jpg`,
                            `${url.origin}${basePath}${fileBase}.webp`
                        ];
                    }
                } catch (e) { }
            }
            return null;
        },
        deepScan: (document) => {
            const nextData = document.getElementById('__NEXT_DATA__');
            if (!nextData) return null;
            try {
                const data = JSON.parse(nextData.textContent);
                const candidates = [];
                const preloadedStateStr = data.props?.pageProps?.serverSerializedPreloadedState;
                if (!preloadedStateStr) return null;

                const state = JSON.parse(preloadedStateStr);

                // イラスト・マンガ
                if (state.illust) {
                    for (const id in state.illust) {
                        const illust = state.illust[id];
                        if (illust.urls && illust.urls.original) {
                            const ext = illust.urls.original.split('.').pop();
                            candidates.push({
                                type: 'image',
                                url: illust.urls.original,
                                thumbnailUrl: illust.urls.regular || illust.urls.medium,
                                filename: `pixiv_${id}_original.${ext}`,
                                isAI: illust.aiType === 2
                            });

                            if (illust.pageCount > 1) {
                                for (let i = 1; i < illust.pageCount; i++) {
                                    candidates.push({
                                        type: 'image',
                                        url: illust.urls.original.replace('_p0', `_p${i}`),
                                        thumbnailUrl: (illust.urls.regular || illust.urls.medium).replace('_p0', `_p${i}`),
                                        filename: `pixiv_${id}_p${i}.${ext}`,
                                        isAI: illust.aiType === 2
                                    });
                                }
                            }
                        }
                    }
                }

                // うごイラ
                if (state.ugoiraMeta) {
                    for (const id in state.ugoiraMeta) {
                        const meta = state.ugoiraMeta[id];
                        if (meta.src) {
                            candidates.push({
                                type: 'archive',
                                url: meta.src,
                                filename: `pixiv_${id}_ugoira.zip`,
                                metadata: { frames: meta.frames },
                                isAI: state.illust?.[id]?.aiType === 2
                            });
                        }
                    }
                }

                // 検索結果 (Hydration)
                if (state.search && state.search.illust && state.search.illust.data) {
                    state.search.illust.data.forEach(work => {
                        if (work.url) {
                            const originalUrl = work.url.replace(/\/c\/[^/]+\//, '/').replace(/\/img-master\//, '/img-original/').replace(/_(square|master)1200/, '');
                            candidates.push({
                                type: 'image',
                                url: originalUrl,
                                thumbnailUrl: work.url,
                                filename: `pixiv_${work.id}_original.${originalUrl.split('.').pop()}`,
                                isAI: work.aiType === 2
                            });
                        }
                    });
                }

                return candidates.length > 0 ? candidates : null;
            } catch (e) {
                console.error('[AI Meta Viewer] Pixiv deepScan error:', e);
                return null;
            }
        },
        getBadgeTargets: () => null
    },
    // Civitai
    {
        match: () => window.location.hostname.includes('civitai.com') || document.title.includes('Civitai'),
        resolve: (img) => {
            const src = img.src || img.currentSrc;
            if (src.includes('image.civitai.com')) {
                return src.replace(/\/width=\d+/, '');
            }
            return null;
        },
        deepScan: (document) => {
            const nextData = document.getElementById('__NEXT_DATA__');
            if (!nextData) {
                console.log('[AI Meta Viewer] Civitai deepScan: __NEXT_DATA__ not found');
                return null;
            }
            try {
                const data = JSON.parse(nextData.textContent);
                const candidates = [];
                const queries = data.props?.pageProps?.trpcState?.json?.queries || [];
                console.log('[AI Meta Viewer] Civitai deepScan: Found', queries.length, 'queries');

                // 最新バージョンを特定するため、modelVersions を持つクエリを探す
                let modelData = null;
                for (const query of queries) {
                    if (query.state?.data?.modelVersions) {
                        modelData = query.state.data;
                        break;
                    }
                }

                if (!modelData) {
                    console.log('[AI Meta Viewer] Civitai deepScan: No modelData found');
                    return null;
                }

                const latestVersionId = modelData?.modelVersions?.[0]?.id;
                console.log('[AI Meta Viewer] Civitai deepScan: Latest version ID:', latestVersionId);

                queries.forEach(query => {
                    const queryData = query.state?.data;
                    if (!queryData) return;

                    // モデルファイル
                    if (queryData.modelVersions) {
                        queryData.modelVersions.forEach(version => {
                            const isLatestVersion = version.id === latestVersionId;
                            let safetensorsSelected = false;

                            if (version.files) {
                                version.files.forEach(file => {
                                    if (file.url) {
                                        // URLまたはファイル名でsafetensorsか判定 (クエリパラメータ除去)
                                        const cleanUrl = file.url.split('?')[0].toLowerCase();
                                        const fileName = (file.name || '').toLowerCase();
                                        const isSafetensors = cleanUrl.endsWith('.safetensors') || fileName.endsWith('.safetensors');

                                        // 最新バージョンの最初のsafetensorsのみ自動選択
                                        const autoSelect = isLatestVersion && isSafetensors && !safetensorsSelected;
                                        if (autoSelect) safetensorsSelected = true;

                                        candidates.push({
                                            type: 'archive',
                                            url: file.url,
                                            filename: file.name || (typeof getFilenameFromUrl === 'function' ? getFilenameFromUrl(file.url) : 'model.safetensors'),
                                            metadata: {
                                                versionName: version.name,
                                                modelName: queryData.name,
                                                size: file.sizeKB * 1024
                                            },
                                            isAI: false, // 修正: AI画像として扱わないことで、scanner.jsのデフォルト全選択ロジックを回避し、autoSelectのみに依存させる
                                            autoSelect: autoSelect, // trueまたはfalseを明示
                                            isCivitaiModel: isSafetensors, // 特殊フラグ
                                            modelName: queryData.name // ZIP化に使用
                                        });
                                        console.log('[AI Meta Viewer] Civitai deepScan: Added safetensors:', file.name, 'autoSelect:', autoSelect, 'isLatestVersion:', isLatestVersion);
                                    }
                                });
                            }
                        });
                    }

                    // ギャラリー画像
                    if (queryData.items && Array.isArray(queryData.items)) {
                        queryData.items.forEach(item => {
                            if (item.url && item.url.includes('image.civitai.com')) {
                                candidates.push({
                                    type: 'image',
                                    url: item.url,
                                    thumbnailUrl: item.url + (item.url.includes('?') ? '&' : '?') + 'width=450',
                                    filename: typeof getFilenameFromUrl === 'function' ? getFilenameFromUrl(item.url) : 'image.png',
                                    metadata: item.meta || null,
                                    isAI: true, // ギャラリー画像はデフォルト選択対象
                                    isCivitaiImage: true,
                                    modelName: modelData?.name || 'Civitai'
                                });
                            }
                        });
                        console.log('[AI Meta Viewer] Civitai deepScan: Added', queryData.items.length, 'gallery images');
                    }
                });

                console.log('[AI Meta Viewer] Civitai deepScan: Total candidates:', candidates.length,
                    'Archives:', candidates.filter(c => c.type === 'archive').length,
                    'Images:', candidates.filter(c => c.type === 'image').length);
                return candidates.length > 0 ? candidates : null;
            } catch (e) {
                console.error('[AI Meta Viewer] Civitai deepScan error:', e);
                return null;
            }
        },
        getBadgeTargets: (document) => {
            // ダウンロードリンクやボタンを物理的に探す
            // hrefに "download" を含むすべてのリンクを対象にする（APIパスの変更や多様性に対応）
            // ただし画像リンクは除外（genericアダプターに任せる、またはここで弾く）
            const links = Array.from(document.querySelectorAll('a[href]'));
            return links.filter(a => {
                const href = a.href;
                // モデルダウンロードAPI、または一般的なダウンロードリンク
                return href && (
                    href.includes('/api/download/') ||
                    (href.includes('download') && href.includes('models'))
                );
            });
        }
    },
    // 汎用 (拡張子チェック)
    {
        match: () => true,
        resolve: (img) => {
            const parentLink = img.closest('a');
            if (parentLink && parentLink.href) {
                const href = parentLink.href;
                const cleanHref = href.split('?')[0];
                if (/\.(png|jpg|jpeg|webp|avif|gif)$/i.test(cleanHref)) {
                    return href;
                }
            }
            return null;
        },
        deepScan: () => null,
        getBadgeTargets: () => null
    }
];
