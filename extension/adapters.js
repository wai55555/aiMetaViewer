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

                        // クエリパラメータから幅・高さ・フォーマット等を除去（これらがあるとメタデータが削除されたWebPが返されるため）
                        const params = new URLSearchParams(url.search);
                        params.delete('format');
                        params.delete('quality');
                        params.delete('width');
                        params.delete('height');

                        // 末尾の空パラメータ等を掃除
                        let newQuery = params.toString();
                        newQuery = newQuery.replace(/(&|\?)?=+$/, '').replace(/=(&|$)/g, '$1');

                        const originalUrl = `https://cdn.discordapp.com/attachments/${attachmentsPath}${newQuery ? '?' + newQuery : ''}`;

                        if (typeof debugLog === 'function') {
                            debugLog('[AI Meta Viewer] Discord thumbnail converted:', {
                                thumbnail: src.substring(0, 80),
                                original: originalUrl.substring(0, 80)
                            });
                        }

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

                    const match = pathname.match(/^(.+\/)(\d+(?:-[a-f0-9]+)?_p\d+).*\.(jpg|png|webp|gif)$/);
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
                debugLog('[AI Meta Viewer] Civitai deepScan: __NEXT_DATA__ not found');
                return null;
            }
            try {
                const data = JSON.parse(nextData.textContent);
                const candidates = [];
                const queries = data.props?.pageProps?.trpcState?.json?.queries || [];
                debugLog('[AI Meta Viewer] Civitai deepScan: Found', queries.length, 'queries');

                // 最新バージョンを特定するため、modelVersions を持つクエリを探す
                let modelData = null;
                for (const query of queries) {
                    if (query.state?.data?.modelVersions) {
                        modelData = query.state.data;
                        break;
                    }
                }

                if (!modelData) {
                    debugLog('[AI Meta Viewer] Civitai deepScan: No modelData found');
                    return null;
                }

                const latestVersionId = modelData?.modelVersions?.[0]?.id;
                debugLog('[AI Meta Viewer] Civitai deepScan: Latest version ID:', latestVersionId);

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

                                        // URL タイプの診断ログ
                                        const isCivitaiApiUrl = file.url.includes('civitai.com/api/download/models/');
                                        const isCloudflareCDN = file.url.includes('cloudflarestorage.com');
                                        const urlType = isCivitaiApiUrl ? '✓ Civitai API' : isCloudflareCDN ? '⚠ Cloudflare CDN' : '? Other';

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
                                        debugLog('[AI Meta Viewer] Civitai deepScan: Added safetensors:', file.name, 'autoSelect:', autoSelect, 'isLatestVersion:', isLatestVersion, 'urlType:', urlType, 'url:', file.url.substring(0, 100));
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
                        debugLog('[AI Meta Viewer] Civitai deepScan: Added', queryData.items.length, 'gallery images');
                    }
                });

                debugLog('[AI Meta Viewer] Civitai deepScan: Total candidates:', candidates.length,
                    'Archives:', candidates.filter(c => c.type === 'archive').length,
                    'Images:', candidates.filter(c => c.type === 'image').length);
                return candidates.length > 0 ? candidates : null;
            } catch (e) {
                console.error('[AI Meta Viewer] Civitai deepScan error:', e);
                return null;
            }
        },
        getBadgeTargets: (document) => {
            // Civitai ダウンロードボタンを高精度に特定する

            // 1. 直接的な .safetensors 拡張子リンク
            const directLinks = Array.from(document.querySelectorAll('a[href*=".safetensors"]'));

            // 2. Civitai API ダウンロード URL を含むリンク
            const apiLinks = Array.from(document.querySelectorAll('a')).filter(el => {
                const href = el.href || '';
                return href.includes('/api/download/models/');
            });

            // 3. "Download" テキストを持つボタンやリンク (React コンポーネント対策)
            const textLinks = Array.from(document.querySelectorAll('a, button')).filter(el => {
                const text = (el.textContent || '').trim();
                return text === 'Download' || text.startsWith('Download (');
            });

            // 重複を除去して返す
            const allTargets = [...directLinks, ...apiLinks, ...textLinks];
            const uniqueTargets = Array.from(new Set(allTargets));

            debugLog('[AI Meta Viewer] getBadgeTargets: Found', uniqueTargets.length, 'unique targets');
            uniqueTargets.forEach((target, index) => {
                const href = target.href || 'no-href';
                const text = (target.textContent || '').trim().substring(0, 30);
                debugLog(`[AI Meta Viewer] Target ${index}: [${target.tagName}] ${text} - ${href.substring(0, 60)}`);
            });

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
 * safetensors 候補をダウンロードボタン要素とマッチングし、バッジを付与する。
 * @param {Array} safetensorsCandidates - deepScan で見つかった候補の配列
 * @param {Array} targets - getBadgeTargets で見つかった DOM 要素の配列
 * @param {Function|null} fetchMetadataCallback - メタデータ取得関数
 */
function processCandidatesWithTargets(safetensorsCandidates, targets, fetchMetadataCallback) {
    safetensorsCandidates.forEach(candidate => {
        const modelVersionId = candidate.modelVersionId;
        debugLog(`[AI Meta Viewer] Processing candidate: ${candidate.filename}, modelVersionId: ${modelVersionId}`);

        let matchedElement = null;
        let apiUrlForFetch = null;

        // 戦略1: modelVersionId による厳格なマッチング (最優先)
        if (modelVersionId) {
            matchedElement = targets.find(el => {
                const href = el.href || '';
                return href.includes(`/models/${modelVersionId}`) || href.includes(`/download/models/${modelVersionId}`);
            }) || null;
            if (matchedElement) {
                apiUrlForFetch = matchedElement.href; // 厳格マッチで見つかった場合はそのhrefを使用
                debugLog(`[AI Meta Viewer] ✓ Strict match by modelVersionId (${modelVersionId}): ${matchedElement.href.substring(0, 100)}`);
            }
        }

        if (!matchedElement) {
            debugLog(`[AI Meta Viewer] ⚠ Strict match failed for ${candidate.filename}. Trying text matching...`);
            const downloadText = (candidate.filename || '').replace('.safetensors', '').toLowerCase();

            matchedElement = targets.find(el => {
                const text = (el.textContent || '').toLowerCase();
                // 1. ボタンに "Download" という単語が含まれていること
                // 2. さらにファイル名の一部（拡張子無し）が含まれていること
                return text.includes('download') && text.includes(downloadText);
            }) || null;

            if (matchedElement) {
                debugLog(`[AI Meta Viewer] ✓ Matched by text content (fallback): ${matchedElement.textContent.trim().substring(0, 30)}`);
            }
        }

        // 戦略3: ターゲットが1つしかない場合、それを Civitai API URL ならマッチとみなす
        // (ただし、候補が「最新バージョン」かつ「自動選択されている」場合は優先度を上げる)
        if (!matchedElement && targets.length === 1) {
            const el = targets[0];
            const href = el.href || '';
            const text = (el.textContent || '').toLowerCase();
            if (href.includes('/api/download/models/') || text.includes('download')) {
                matchedElement = el;
                debugLog(`[AI Meta Viewer] ✓ Single target fallback: ${href.substring(0, 60)}`);
            }
        }

        if (!matchedElement) {
            // debugLog(`[AI Meta Viewer] ⚠ Could not find any matching element for: ${candidate.filename}`);
            return;
        }

        // 既処理の要素はスキップ
        if (matchedElement && typeof processedImages !== 'undefined' && processedImages.has(matchedElement)) {
            const existingEntry = processedImages.get(matchedElement);
            if (existingEntry && existingEntry.badge && modelVersionId) {
                // DOM上のバッジ要素から情報を取得（badge_controller.jsで作られたDOM要素）
                const badgeEl = existingEntry.badge instanceof HTMLElement ? existingEntry.badge : matchedElement.querySelector('.ai-meta-badge');
                if (badgeEl) {
                    const currentBadgeUrl = badgeEl.getAttribute('data-api-url') || '';
                    if (currentBadgeUrl.includes(modelVersionId)) {
                        // 同じメタデータのバッジが既に付いているのでスキップ
                        return;
                    }
                }
                // 別のメタデータのバッジが付いている場合は削除
                removeBadge(matchedElement);
            } else if (existingEntry) {
                // バッジがあるが詳細不明な場合も一応削除
                removeBadge(matchedElement);
            }
        }

        // apiUrl がまだ構築されていなければ構築しておく
        // (matchedElement.href が利用可能な場合はそれを優先し、無ければ ID から生成)
        if (!apiUrlForFetch) {
            if (matchedElement && matchedElement.href && matchedElement.href.includes('/api/download/models/')) {
                apiUrlForFetch = matchedElement.href;
            } else if (modelVersionId) {
                // クエリパラメータを最小限にして 404 を防ぐ（サーバー側のリダイレクトに任せる）
                apiUrlForFetch = `https://civitai.com/api/download/models/${modelVersionId}`;
            }
        }

        if (typeof fetchMetadataCallback === 'function' && apiUrlForFetch) {
            debugLog(`[AI Meta Viewer] Fetching real metadata via callback for: ${candidate.filename}, url: ${apiUrlForFetch}`);
            fetchMetadataCallback(apiUrlForFetch).then(realMetadata => {
                if (realMetadata && Object.keys(realMetadata).length > 0) {
                    debugLog(`[AI Meta Viewer] ✓ Got real metadata, adding badge. Keys: ${Object.keys(realMetadata).join(', ')}`);

                    if (typeof addBadgeToElement === 'function') {
                        const badge = addBadgeToElement(matchedElement, realMetadata, candidate.url);
                        // バッジにソースURLを記録して後で比較できるようにする
                        if (badge && modelVersionId) {
                            badge.setAttribute('data-api-url', apiUrlForFetch);
                        }
                    }
                } else {
                    debugLog(`[AI Meta Viewer] ⚠ Real metadata empty, removing any existing badge for: ${candidate.filename}`);
                    removeBadge(matchedElement);
                }
            }).catch(err => {
                console.error(`[AI Meta Viewer] Metadata fetch error for ${candidate.filename}:`, err.message);
            });
        }
        else {
            debugLog(`[AI Meta Viewer] Element found but no fetchMetadataCallback provided. Skipping badge.`);
        }
    });
}

/**
 * 各アダプターの deepScan を実行し、対応するダウンロードボタンにバッジを付与する。
 * @param {Function|null} fetchMetadataCallback - メタデータ取得関数 (apiUrl) => Promise<object|null>
 *   渡された場合はその関数で本物のメタデータを取得してバッジを付与する。
 *   渡されない場合はバッジ付与を行わない（ドライラン）。
 */
function executeDeepScanAndAddBadges(fetchMetadataCallback = null) {
    if (typeof SiteAdapters === 'undefined') {
        debugLog('[AI Meta Viewer] SiteAdapters not available');
        return;
    }

    for (const adapter of SiteAdapters) {
        if (adapter.match() && typeof adapter.deepScan === 'function') {
            try {
                const candidates = adapter.deepScan(document);
                if (!candidates || !Array.isArray(candidates)) continue;

                debugLog(`[AI Meta Viewer] executeDeepScanAndAddBadges: Found ${candidates.length} candidates`);
                candidates.forEach((c, i) => {
                    debugLog(`[AI Meta Viewer] Candidate ${i}: type=${c.type}, isCivitaiModel=${c.isCivitaiModel}, hasMetadata=${!!c.metadata}, filename=${c.filename}`);
                });

                // safetensors ファイルの候補のみを対象にする
                const safetensorsCandidates = candidates.filter(c =>
                    c.type === 'archive' && c.isCivitaiModel && c.metadata
                );
                debugLog(`[AI Meta Viewer] Filtered to ${safetensorsCandidates.length} safetensors candidates with metadata`);

                if (safetensorsCandidates.length === 0) {
                    debugLog('[AI Meta Viewer] No safetensors candidates with metadata found');
                    continue;
                }

                // ダウンロードボタンを取得（リトライ付き）
                // Civitai は React SPA であり、ダウンロードボタンの <a> 要素が
                // 遅延レンダリングされることがある。ターゲットが0件の場合はリトライする。
                const MAX_RETRY_COUNT = 5;
                const RETRY_INTERVAL_MS = 1000;

                const attemptBadgePlacement = (retryIndex, adapterRef, safetensorsCandidatesRef) => {
                    const currentTargets = adapterRef.getBadgeTargets?.(document) || [];
                    debugLog(`[AI Meta Viewer] Badge placement attempt ${retryIndex + 1}/${MAX_RETRY_COUNT + 1}: Found ${currentTargets.length} targets`);
                    currentTargets.forEach((t, i) => {
                        debugLog(`[AI Meta Viewer] Target ${i}: ${t.href}`);
                    });

                    if (currentTargets.length === 0) {
                        if (retryIndex < MAX_RETRY_COUNT) {
                            debugLog(`[AI Meta Viewer] No targets found yet, retrying in ${RETRY_INTERVAL_MS}ms...`);
                            setTimeout(() => attemptBadgePlacement(retryIndex + 1, adapterRef, safetensorsCandidatesRef), RETRY_INTERVAL_MS);
                            return;
                        }
                        debugLog('[AI Meta Viewer] ⚠ No download button targets found after all retries');
                        return;
                    }

                    // ターゲットが見つかったので、各候補にバッジを付与する
                    processCandidatesWithTargets(safetensorsCandidatesRef, currentTargets, fetchMetadataCallback);
                };

                attemptBadgePlacement(0, adapter, safetensorsCandidates);
            } catch (e) {
                console.error('[AI Meta Viewer] executeDeepScanAndAddBadges error:', e);
            }
        }
    }
}

