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

            // 3. サムネイル画像からオリジナル URL への変換
            // media.discordapp.net/attachments/... -> cdn.discordapp.com/attachments/...
            const src = img.src || img.currentSrc;
            if (src && src.includes('media.discordapp.net/attachments/')) {
                try {
                    // サムネイル URL の例:
                    // https://media.discordapp.net/attachments/1284860627151753359/1326573297953148968/00103-4200756156.png?ex=694e00e8&is=694caf68&hm=506f8bf4eed254c2f3d60a8eac9bfb89e6c6c21302bcff3b59153b271ad0f59e&=&format=webp&quality=lossless&width=273&height=173
                    // オリジナル URL:
                    // https://cdn.discordapp.com/attachments/1284860627151753359/1326573297953148968/00103-4200756156.png?ex=694e00e8&is=694caf68&hm=506f8bf4eed254c2f3d60a8eac9bfb89e6c6c21302bcff3b59153b271ad0f59e&

                    const url = new URL(src);
                    const pathname = url.pathname;

                    // /attachments/ 以降を抽出
                    const attachmentsMatch = pathname.match(/\/attachments\/(.+)$/);
                    if (attachmentsMatch) {
                        const attachmentsPath = attachmentsMatch[1];

                        // クエリパラメータから width/height/format/quality を除去
                        const params = new URLSearchParams(url.search);
                        params.delete('format');
                        params.delete('quality');
                        params.delete('width');
                        params.delete('height');

                        const newQuery = params.toString();
                        const originalUrl = `https://cdn.discordapp.com/attachments/${attachmentsPath}${newQuery ? '?' + newQuery : ''}`;

                        console.log('[AI Meta Viewer] Discord thumbnail converted:', {
                            thumbnail: src.substring(0, 80),
                            original: originalUrl.substring(0, 80)
                        });

                        return originalUrl;
                    }
                } catch (e) {
                    console.error('[AI Meta Viewer] Discord thumbnail conversion error:', e);
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
                                            modelName: queryData.name, // ZIP化に使用
                                            modelVersionId: version.id // Civitai API URL 構築用
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
            // Civitaiのダウンロードボタンは <a href> ではなく、JavaScriptで処理される
            // 代わりに、ダウンロード関連のボタンやリンクを広く探す

            // 1. 直接的なsafetensorsリンク
            const directLinks = Array.from(document.querySelectorAll('a[href*=".safetensors"]'));

            // 2. ダウンロードボタン（テキストやクラスから判定）
            const downloadButtons = Array.from(document.querySelectorAll('button, a')).filter(el => {
                const text = el.textContent?.toLowerCase() || '';
                const href = el.href?.toLowerCase() || '';
                const className = el.className?.toLowerCase() || '';

                // ダウンロード関連のテキストやクラスを含む
                return (
                    text.includes('download') ||
                    className.includes('download') ||
                    href.includes('download') ||
                    href.includes('model') ||
                    href.includes('safetensors')
                );
            });

            // 3. 重複を除去して返す
            const allTargets = [...directLinks, ...downloadButtons];
            const uniqueTargets = Array.from(new Set(allTargets));

            return uniqueTargets;
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

/**
 * サイトアダプターのdeepScanを実行してバッジを追加
 * content.js と scanner.js の両方から呼び出し可能
 * 
 * @description
 * ページ読み込み完了後にdeepScanを実行し、
 * 見つかった候補にバッジを追加する共有関数
 */
function executeDeepScanAndAddBadges() {
    if (typeof SiteAdapters === 'undefined') {
        console.log('[AI Meta Viewer] SiteAdapters not available');
        return;
    }

    for (const adapter of SiteAdapters) {
        if (adapter.match() && typeof adapter.deepScan === 'function') {
            try {
                const candidates = adapter.deepScan(document);
                if (candidates && Array.isArray(candidates)) {
                    console.log(`[AI Meta Viewer] executeDeepScanAndAddBadges: Found ${candidates.length} candidates`);

                    // デバッグ: 全候補を表示
                    candidates.forEach((c, i) => {
                        console.log(`[AI Meta Viewer] Candidate ${i}: type=${c.type}, isCivitaiModel=${c.isCivitaiModel}, hasMetadata=${!!c.metadata}, filename=${c.filename}`);
                    });

                    // safetensorsファイルの候補のみを処理
                    const safetensorsCandidates = candidates.filter(c =>
                        c.type === 'archive' && c.isCivitaiModel && c.metadata
                    );

                    console.log(`[AI Meta Viewer] Filtered to ${safetensorsCandidates.length} safetensors candidates with metadata`);

                    if (safetensorsCandidates.length === 0) {
                        console.log('[AI Meta Viewer] No safetensors candidates with metadata found');
                        return;
                    }

                    // ダウンロードボタンを取得
                    const targets = adapter.getBadgeTargets?.(document) || [];
                    console.log(`[AI Meta Viewer] Found ${targets.length} download button targets`);

                    // デバッグ: ターゲットのURLを表示
                    targets.forEach((t, i) => {
                        console.log(`[AI Meta Viewer] Target ${i}: ${t.href}`);
                    });

                    // 各候補のURLに対応するダウンロードボタンを探してバッジを追加
                    safetensorsCandidates.forEach(candidate => {
                        // 候補のURLを正規化（クエリパラメータ除去）
                        const candidateUrl = candidate.url.split('?')[0].toLowerCase();
                        console.log(`[AI Meta Viewer] Processing candidate: ${candidate.filename}, URL: ${candidateUrl}`);

                        // 対応するダウンロードボタンを探す
                        let matched = false;
                        targets.forEach(el => {
                            const targetUrl = (el.href || '').split('?')[0].toLowerCase();

                            // URLが一致するか、またはファイル名が一致するかチェック
                            const urlMatch = targetUrl === candidateUrl || targetUrl.includes(candidateUrl);
                            const filenameMatch = candidate.filename && targetUrl.includes(candidate.filename.split('.')[0]);

                            if (urlMatch || filenameMatch) {
                                console.log(`[AI Meta Viewer] Match found! urlMatch=${urlMatch}, filenameMatch=${filenameMatch}`);
                                matched = true;

                                if (typeof processedImages !== 'undefined' && !processedImages.has(el)) {
                                    console.log(`[AI Meta Viewer] Adding badge to download button for: ${candidate.filename}`);

                                    // バッジを追加
                                    if (typeof addBadgeToElement === 'function') {
                                        addBadgeToElement(el, candidate.metadata, candidate.url);
                                    }

                                    processedImages.set(el, {
                                        badge: {
                                            metadata: candidate.metadata,
                                            url: candidate.url
                                        }
                                    });
                                } else {
                                    console.log(`[AI Meta Viewer] Element already processed or processedImages not available`);
                                }
                            }
                        });

                        if (!matched) {
                            console.log(`[AI Meta Viewer] No matching download button found for: ${candidate.filename}`);

                            // 代替案: DOMで候補URLを含む要素を直接検索
                            console.log(`[AI Meta Viewer] Attempting to find element by URL in DOM...`);
                            const allElements = document.querySelectorAll('*');
                            for (const el of allElements) {
                                // href属性をチェック
                                if (el.href && typeof el.href === 'string' && el.href.toLowerCase().includes(candidateUrl)) {
                                    console.log(`[AI Meta Viewer] Found element by href: ${el.tagName}`);
                                    if (typeof processedImages !== 'undefined' && !processedImages.has(el)) {
                                        if (typeof addBadgeToElement === 'function') {
                                            addBadgeToElement(el, candidate.metadata, candidate.url);
                                        }
                                        processedImages.set(el, {
                                            badge: {
                                                metadata: candidate.metadata,
                                                url: candidate.url
                                            }
                                        });
                                        matched = true;
                                        break;
                                    }
                                }

                                // data属性をチェック
                                if (el.attributes) {
                                    for (const attr of el.attributes) {
                                        if (attr.value && typeof attr.value === 'string' && attr.value.toLowerCase().includes(candidateUrl)) {
                                            console.log(`[AI Meta Viewer] Found element by data attribute: ${el.tagName}`);
                                            if (typeof processedImages !== 'undefined' && !processedImages.has(el)) {
                                                if (typeof addBadgeToElement === 'function') {
                                                    addBadgeToElement(el, candidate.metadata, candidate.url);
                                                }
                                                processedImages.set(el, {
                                                    badge: {
                                                        metadata: candidate.metadata,
                                                        url: candidate.url
                                                    }
                                                });
                                                matched = true;
                                                break;
                                            }
                                        }
                                    }
                                }

                                if (matched) break;
                            }
                        }

                        if (!matched) {
                            console.log(`[AI Meta Viewer] Could not find any element for: ${candidate.filename}`);
                        }
                    });
                }
            } catch (e) {
                console.error('[AI Meta Viewer] executeDeepScanAndAddBadges error:', e);
            }
        }
    }
}
