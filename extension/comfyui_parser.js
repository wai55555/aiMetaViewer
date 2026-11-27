/* Pure ComfyUI graph normalizer shared by metadata rendering and tests. */
(function (root) {
    'use strict';

    if (root.__aiMetaViewerAbortUiModule === true) {
        throw new Error('AI Meta Viewer UI module aborted by navigation guard');
    }

    const MAX_NODES = 10000;
    const OUTPUT_TYPE = /^(?:SaveImage|PreviewImage|SaveAnimated|VideoCombine|VHS_VideoCombine|SaveVideo|SaveGif)/i;
    const TEXT_TYPE = /(?:CLIPTextEncode|TextEncode)/i;
    const SAMPLER_TYPE = /(?:KSampler|SamplerCustom)/i;
    const MODEL_TYPE = /(?:CheckpointLoader|UNETLoader|DiffusionModelLoader)/i;
    const LORA_TYPE = /LoraLoader/i;
    const MAX_GRAPH_WORK = 100000;
    const MAX_GRAPH_LINKS = 20000;
    const MAX_SUMMARY_ITEMS = 200;
    const MAX_SUMMARY_OUTPUTS = 100;

    //
    // Text resolver table (skeleton).
    //
    // Only node semantics that have been verified are listed here. A node type
    // that is missing from the table produces no prompt text at all: the
    // resolver never guesses by position, so a half-understood custom node
    // cannot invent a prompt (or swap positive and negative).
    //
    // Entry shape:
    //   fields          ordered input names that carry prompt text (literal or link)
    //   join            separator used when more than one field resolves (default '\n')
    //   prefer          take the first non-empty field only (wildcards)
    //   role            'carrier' (default) or 'concat'
    //   parts           explicit concat inputs, or partsPattern + sort ('numeric'|'alpha')
    //   delimiterField  concat separator input name (default 'delimiter')
    //   delimiterMode   'named' maps none/space/comma/newline, otherwise literal
    //   defaultDelimiter used when the delimiter input is absent/empty
    //   widgets         optional widgets_values order for UI-format (workflow) graphs
    //   outputs / negativeFields  reserved for later stages
    //
    const TEXT_RESOLVERS = new Map();

    function normalizeResolverType(type) {
        return String(type == null ? '' : type).trim().toLowerCase();
    }

    function registerTextResolver(type, spec) {
        const key = normalizeResolverType(type);
        if (!key || !spec || typeof spec !== 'object') return false;
        const fields = Array.isArray(spec.fields)
            ? spec.fields.filter(field => typeof field === 'string' && field.trim())
            : [];
        const partsPattern = typeof spec.partsPattern === 'string' ? spec.partsPattern : '';
        const role = spec.role === 'concat' ? 'concat' : 'carrier';
        if (role === 'concat') {
            if (!Array.isArray(spec.parts) && !partsPattern) return false;
        } else if (fields.length === 0) {
            return false;
        }
        const entry = {
            role,
            fields: fields.slice(),
            join: typeof spec.join === 'string' ? spec.join : '\n',
        };
        if (Array.isArray(spec.parts) && spec.parts.length > 0) {
            entry.parts = spec.parts.filter(part => typeof part === 'string' && part.trim());
        }
        if (partsPattern) entry.partsPattern = partsPattern;
        if (spec.sort === 'numeric' || spec.sort === 'alpha') entry.sort = spec.sort;
        if (spec.prefer === true) entry.prefer = true;
        if (typeof spec.delimiterField === 'string' && spec.delimiterField.trim()) {
            entry.delimiterField = spec.delimiterField;
        }
        if (spec.delimiterMode === 'named') entry.delimiterMode = 'named';
        if (typeof spec.defaultDelimiter === 'string') entry.defaultDelimiter = spec.defaultDelimiter;
        if (Array.isArray(spec.widgets) && spec.widgets.length > 0) {
            entry.widgets = spec.widgets.filter(field => typeof field === 'string' && field.trim());
        }
        if (Array.isArray(spec.negativeFields) && spec.negativeFields.length > 0) {
            entry.negativeFields = spec.negativeFields.slice();
        }
        if (Array.isArray(spec.outputs) && spec.outputs.length > 0) {
            entry.outputs = spec.outputs.slice();
        }
        TEXT_RESOLVERS.set(key, entry);
        return true;
    }

    function textResolverFor(type) {
        return TEXT_RESOLVERS.get(normalizeResolverType(type)) || null;
    }

    function resetTextResolvers() {
        TEXT_RESOLVERS.clear();
        BUILTIN_TEXT_RESOLVERS.forEach(spec => registerTextResolver(spec.type, spec));
    }

    // Verified core text encoders. Custom-node packs are intentionally absent
    // until their semantics are confirmed against their source.
    const BUILTIN_TEXT_RESOLVERS = [
        // --- encoders (role comes from the consumer) -----------------------
        { type: 'CLIPTextEncode', fields: ['text'], widgets: ['text'] },
        { type: 'CLIPTextEncodeSDXL', fields: ['text_g', 'text_l'], widgets: ['width', 'height', 'crop_w', 'crop_h', 'target_width', 'target_height', 'text_g', 'text_l'] },
        { type: 'CLIPTextEncodeSDXLRefiner', fields: ['text'], widgets: ['ascore', 'width', 'height', 'text'] },
        { type: 'CLIPTextEncodeFlux', fields: ['clip_l', 't5xxl'] },
        { type: 'CLIPTextEncodeSD3', fields: ['clip_l', 'clip_g', 't5xxl'] },
        { type: 'CLIPTextEncodePixArtAlpha', fields: ['text'] },
        { type: 'CLIPTextEncodeHunyuanDiT', fields: ['bert', 'mt5xl'] },
        // class_type strings, not Python class names: Inspire appends
        // " //Inspire" and essentials registers the SDXL encoder as
        // "CLIPTextEncodeSDXL+".
        { type: 'CLIPTextEncodeWithWeight //Inspire', fields: ['text'] },
        { type: 'CLIPTextEncodeSDXL+', fields: ['text'] },
        { type: 'smZ CLIPTextEncode', fields: ['text', 'text_g', 'text_l'] },
        { type: 'Text to Conditioning', fields: ['text'] },
        { type: 'CLIPTextEncode (NSP)', fields: ['text'] },

        // --- plain STRING holders -----------------------------------------
        { type: 'PrimitiveString', fields: ['value'] },
        { type: 'PrimitiveStringMultiline', fields: ['value'] },
        { type: 'Text Prompt (JPS)', fields: ['text'] },
        { type: 'Text Multiline', fields: ['text'] },
        { type: 'StringConstant', fields: ['string'] },
        { type: 'StringConstantMultiline', fields: ['string'] },
        { type: 'DF_Text', fields: ['Text'] },
        { type: 'DF_Text_Box', fields: ['Text'] },
        { type: 'Power Prompt (rgthree)', fields: ['prompt'] },
        { type: 'Power Prompt - Simple (rgthree)', fields: ['prompt'] },
        { type: 'SDXL Power Prompt - Positive (rgthree)', fields: ['prompt_g', 'prompt_l'] },
        { type: 'SDXL Power Prompt - Simple / Negative (rgthree)', fields: ['prompt_g', 'prompt_l'] },
        { type: 'PromptBuilder //Inspire', fields: ['text'] },
        { type: 'TextEncodeForSamplerParams', fields: ['text'] },

        // --- wildcard: the expanded text is what actually got encoded ----
        { type: 'ImpactWildcardProcessor', fields: ['populated_text', 'wildcard_text'], prefer: true },
        { type: 'ImpactWildcardEncode', fields: ['populated_text', 'wildcard_text'], prefer: true },
        { type: 'WildcardEncode //Inspire', fields: ['populated_text', 'wildcard_text'], prefer: true },

        // --- concatenation (deterministic, declaration order) ------------
        { type: 'Text Concatenate (JPS)', role: 'concat', parts: ['text1', 'text2', 'text3', 'text4', 'text5'], delimiterField: 'delimiter', delimiterMode: 'named' },
        { type: 'StringConcatenate', role: 'concat', parts: ['string_a', 'string_b'], delimiterField: 'delimiter', defaultDelimiter: '' },
        { type: 'JoinStrings', role: 'concat', parts: ['string1', 'string2'], delimiterField: 'delimiter', defaultDelimiter: ' ' },
        { type: 'JoinStringMulti', role: 'concat', partsPattern: '^string_\\d+$', sort: 'numeric', delimiterField: 'delimiter', defaultDelimiter: ' ' },
        { type: 'Text Concatenate', role: 'concat', partsPattern: '^text_[a-z]$', sort: 'alpha', delimiterField: 'delimiter', defaultDelimiter: ', ' },
        { type: 'SDPromptMerger', fields: ['text_g', 'text_l'], join: '\n' },
    ];
    BUILTIN_TEXT_RESOLVERS.forEach(spec => registerTextResolver(spec.type, spec));

    // Python's json.dumps writes bare NaN/Infinity, which JSON.parse rejects.
    // ComfyUI API prompts contain them whenever a widget evaluates to NaN
    // (MathExpression, Random Number, ...), so the whole graph would otherwise
    // be dropped. Replace those tokens with null, but only outside strings.
    const NON_FINITE_TOKEN = /^(?:-?Infinity|NaN)/;
    const IDENT_CHAR = /[\w$.]/;

    function relaxNonFiniteJson(text) {
        if (!text.includes('NaN') && !text.includes('Infinity')) return text;
        let out = '';
        let inString = false;
        let escaped = false;
        let index = 0;
        while (index < text.length) {
            const char = text[index];
            if (inString) {
                out += char;
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                index += 1;
                continue;
            }
            if (char === '"') {
                inString = true;
                out += char;
                index += 1;
                continue;
            }
            const token = NON_FINITE_TOKEN.exec(text.slice(index, index + 10));
            const previous = index > 0 ? text[index - 1] : '';
            const next = text[index + (token ? token[0].length : 0)] || '';
            if (token && !IDENT_CHAR.test(previous) && !IDENT_CHAR.test(next)) {
                out += 'null';
                index += token[0].length;
                continue;
            }
            out += char;
            index += 1;
        }
        return out;
    }

    function parseJson(value) {
        if (typeof value !== 'string') return value;
        const text = value.trim();
        if (!text || (text[0] !== '{' && text[0] !== '[')) return null;
        try { return JSON.parse(text); } catch (_) { /* fall through */ }
        try { return JSON.parse(relaxNonFiniteJson(text)); } catch (_) { return null; }
    }

    function display(value) {
        if (value == null) return '';
        if (typeof value === 'string') return value.trim();
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return '';
    }

    function nodeType(node) {
        return String(node?.class_type || node?.type || node?.title || 'Unknown');
    }

    function widgetValuesFor(node) {
        const values = Array.isArray(node?.widgets_values) ? node.widgets_values : [];
        const type = nodeType(node);
        let names = [];
        const resolver = textResolverFor(type);
        if (resolver && Array.isArray(resolver.widgets)) names = resolver.widgets;
        else if (/^CheckpointLoaderSimple$/i.test(type)) names = ['ckpt_name'];
        else if (/^(?:UNETLoader|DiffusionModelLoader)$/i.test(type)) names = ['unet_name'];
        else if (/LoraLoaderModelOnly/i.test(type)) names = ['lora_name', 'strength_model'];
        else if (/LoraLoader/i.test(type)) names = ['lora_name', 'strength_model', 'strength_clip'];
        else if (/KSamplerAdvanced/i.test(type)) names = ['add_noise', 'noise_seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'];
        else if (/KSampler/i.test(type)) names = ['seed', 'control_after_generate', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'];
        else if (/CLIPTextEncodeSDXL/i.test(type)) names = ['width', 'height', 'crop_w', 'crop_h', 'target_width', 'target_height', 'text_g', 'text_l'];
        else if (TEXT_TYPE.test(type)) names = ['text'];
        else if (/VHS_VideoCombine|VideoCombine/i.test(type)) names = ['frame_rate', 'loop_count', 'filename_prefix', 'format', 'pingpong', 'save_output'];
        const result = {};
        names.forEach((name, index) => {
            if (index < values.length && values[index] !== undefined) result[name] = values[index];
        });
        return result;
    }

    function normalizeGraph(graphValue) {
        const graph = parseJson(graphValue);
        if (!graph || typeof graph !== 'object') return null;
        let sourceNodes;
        let sourceTruncated = false;
        if (Array.isArray(graph.nodes)) {
            sourceTruncated = graph.nodes.length > MAX_NODES;
            sourceNodes = graph.nodes.slice(0, MAX_NODES);
        } else {
            sourceNodes = [];
            for (const id in graph) {
                if (!Object.prototype.hasOwnProperty.call(graph, id)) continue;
                const value = graph[id];
                if (!value || typeof value !== 'object' || Array.isArray(value) || !(value.class_type || value.inputs)) continue;
                if (sourceNodes.length >= MAX_NODES) {
                    sourceTruncated = true;
                    break;
                }
                sourceNodes.push({ ...value, id });
            }
        }
        if (sourceNodes.length === 0) return null;

        const nodes = new Map();
        const inbound = new Map();
        let graphLinkCount = 0;
        for (const raw of sourceNodes) {
            if (!raw || typeof raw !== 'object') continue;
            // UI-format graphs mark muted (2) and bypassed (4) nodes. They did
            // not run, so their widgets must not supply prompts or LoRAs.
            const mode = Number(raw.mode);
            if (mode === 2 || mode === 4) continue;
            const id = String(raw.id ?? raw.node_id ?? '');
            if (!id || nodes.has(id)) continue;
            const rawInputs = Object.create(null);
            if (raw.inputs && typeof raw.inputs === 'object' && !Array.isArray(raw.inputs)) {
                Object.assign(rawInputs, raw.inputs);
            }
            const uiInputs = Array.isArray(raw.inputs) ? raw.inputs : [];
            for (const input of uiInputs) {
                if (input && typeof input.name === 'string' && Object.prototype.hasOwnProperty.call(input, 'value')) {
                    rawInputs[input.name] = input.value;
                }
            }
            Object.assign(rawInputs, widgetValuesFor(raw));
            const type = nodeType(raw);
            const node = {
                id,
                raw,
                type,
                title: String(raw.title || raw.properties?.['Node name'] || type),
                inputs: rawInputs,
                // Resolved once per node: the table is static for the duration
                // of a summarize() call, and this keeps the hot path off
                // repeated trim/lowercase work.
                resolver: TEXT_RESOLVERS.get(normalizeResolverType(type)) || null,
            };
            nodes.set(id, node);
            inbound.set(id, []);
        }

        const addLink = (targetId, inputName, originId, originSlot = null) => {
            const target = inbound.get(String(targetId));
            if (!target || !nodes.has(String(originId))) return;
            if (graphLinkCount >= MAX_GRAPH_LINKS) {
                sourceTruncated = true;
                return;
            }
            target.push({ name: String(inputName || ''), originId: String(originId), originSlot });
            graphLinkCount += 1;
        };

        // API prompt format stores each connected input as [nodeId, outputSlot].
        for (const node of nodes.values()) {
            if (Array.isArray(node.raw.inputs)) continue;
            for (const [name, value] of Object.entries(node.raw.inputs || {})) {
                if (Array.isArray(value) && value.length >= 1 && nodes.has(String(value[0]))) {
                    addLink(node.id, name, value[0], value[1]);
                }
            }
        }

        // UI workflow links are [linkId, originNode, originSlot, targetNode, targetSlot, type].
        const workflowLinks = Array.isArray(graph.links) ? graph.links : [];
        const linksById = new Map();
        let workflowLinkCount = 0;
        for (const link of workflowLinks) {
            if (++workflowLinkCount > MAX_GRAPH_LINKS) {
                sourceTruncated = true;
                break;
            }
            if (Array.isArray(link) && link.length >= 5) linksById.set(String(link[0]), link);
            else if (link && typeof link === 'object') linksById.set(String(link.id), link);
        }
        for (const node of nodes.values()) {
            if (!Array.isArray(node.raw.inputs)) continue;
            node.raw.inputs.forEach((input, targetSlot) => {
                if (!input || input.link == null) return;
                const link = linksById.get(String(input.link));
                if (!link) return;
                const originId = Array.isArray(link) ? link[1] : link.origin_id ?? link.originId;
                const originSlot = Array.isArray(link) ? link[2] : link.origin_slot ?? link.originSlot;
                addLink(node.id, input.name, originId, originSlot);
                void targetSlot;
            });
        }

        return { nodes, inbound, limited: sourceTruncated };
    }

    function inputValue(node, ...names) {
        const keys = Object.keys(node.inputs || {});
        for (const name of names) {
            if (Object.prototype.hasOwnProperty.call(node.inputs, name)) {
                const value = node.inputs[name];
                if (!(Array.isArray(value) && value.length >= 1)) {
                    const text = display(value);
                    if (text) return text;
                }
            }
            const key = keys.find(candidate => candidate.toLowerCase() === name.toLowerCase());
            if (key && !(Array.isArray(node.inputs[key]) && node.inputs[key].length >= 1)) {
                const text = display(node.inputs[key]);
                if (text) return text;
            }
        }
        return '';
    }

    function consumeGraphWork(budget) {
        if (budget.remaining <= 0) {
            budget.exhausted = true;
            return false;
        }
        budget.remaining -= 1;
        return true;
    }

    function addUniqueBounded(items, seen, item, budget) {
        const token = `${item.label}\0${item.text}`;
        if (seen.has(token)) return true;
        if (items.length >= MAX_SUMMARY_ITEMS) {
            budget.exhausted = true;
            return false;
        }
        seen.add(token);
        items.push(item);
        return true;
    }

    function ancestors(graph, startId, budget) {
        const seen = new Set();
        const stack = [String(startId)];
        while (stack.length && seen.size < MAX_NODES && consumeGraphWork(budget)) {
            const id = stack.pop();
            if (seen.has(id) || !graph.nodes.has(id)) continue;
            seen.add(id);
            for (const link of graph.inbound.get(id) || []) {
                if (!consumeGraphWork(budget)) break;
                stack.push(link.originId);
            }
        }
        if (stack.length && seen.size >= MAX_NODES) budget.exhausted = true;
        return seen;
    }

    // Compatibility shim for encoder variants that follow the ComfyUI naming
    // convention but are not table entries yet ("smZ CLIPTextEncode",
    // "CLIPTextEncode (NSP)", ...). It reproduces the previous behaviour for
    // those names only; anything else stays unresolved.
    const LEGACY_ENCODER_FIELDS = ['text', 'prompt', 'text_g', 'clip_g', 'text_l', 'clip_l', 't5xxl'];

    function legacyEncoderFields(node) {
        return TEXT_TYPE.test(node.type) ? LEGACY_ENCODER_FIELDS : null;
    }

    function isTextCarrier(node) {
        return Boolean(node.resolver || legacyEncoderFields(node));
    }

    //
    // Composed text resolution.
    //
    // A carrier may hold its text as a link instead of a literal (CLIPTextEncode
    // wired to a concat chain, Efficient Loader wired to JPS prompts, ...).
    // Resolving such a link keeps the declaration order and the node's own
    // delimiter, which is what makes a concatenation chain come out as one
    // prompt instead of several fragments.
    //
    const MAX_TEXT_DEPTH = 16;

    //
    // LoRA tables (catalogue §3.10). Same rule as text: only verified
    // class_type strings are listed, and nothing is guessed.
    //
    const LORA_RESOLVERS = new Map();

    function loraResolverFor(type) {
        return LORA_RESOLVERS.get(normalizeResolverType(type)) || null;
    }

    function registerLoraResolver(type, spec) {
        const key = normalizeResolverType(type);
        if (!key || !spec || typeof spec.kind !== 'string') return false;
        LORA_RESOLVERS.set(key, { kind: spec.kind });
        return true;
    }

    const BUILTIN_LORA_RESOLVERS = [
        // {on, lora, strength, strengthTwo} under lora_1..N (unbounded)
        { type: 'Power Lora Loader (rgthree)', kind: 'power' },
        // lora_01/strength_01 .. lora_04/strength_04
        { type: 'Lora Loader Stack (rgthree)', kind: 'pairs' },
        // lora_count + lora_name_i/lora_wt_i/model_str_i/clip_str_i (1..50)
        { type: 'LoRA Stacker', kind: 'efficiency' },
    ];
    BUILTIN_LORA_RESOLVERS.forEach(spec => registerLoraResolver(spec.type, spec));

    function resetLoraResolvers() {
        LORA_RESOLVERS.clear();
        BUILTIN_LORA_RESOLVERS.forEach(spec => registerLoraResolver(spec.type, spec));
    }

    function numericSuffix(key) {
        const match = String(key).match(/(\d+)$/);
        return match ? Number(match[1]) : 0;
    }

    function formatLora(name, modelStrength, clipStrength) {
        const clip = clipStrength == null ? '' : String(clipStrength);
        const model = modelStrength == null ? '' : String(modelStrength);
        if (!model) return name;
        if (clip && clip !== model) return `${name} (model ${model}, clip ${clip})`;
        return `${name} (${model})`;
    }

    function definitionEntries(node) {
        // UI workflows keep the Power Lora Loader rows as a list of dicts in
        // widgets_values; API prompts keep them as lora_N inputs.
        const entries = [];
        const inputs = node.inputs || {};
        for (const key of Object.keys(inputs)) {
            if (/^lora_\d+$/.test(key) && inputs[key] && typeof inputs[key] === 'object') {
                entries.push([numericSuffix(key), inputs[key]]);
            }
        }
        if (entries.length === 0 && Array.isArray(node.raw?.widgets_values)) {
            for (const [index, value] of node.raw.widgets_values.entries()) {
                if (value && typeof value === 'object' && ('lora' in value || 'on' in value)) {
                    entries.push([index, value]);
                }
            }
        }
        return entries.sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
    }

    function lorasFor(node) {
        const spec = loraResolverFor(node.type);
        const items = [];
        if (!spec) {
            const name = inputValue(node, 'lora_name', 'adapter_name', 'filename');
            if (!name) return items;
            const strength = inputValue(node, 'strength_model', 'strength');
            items.push({ name, text: formatLora(name, strength) });
            return items;
        }
        if (spec.kind === 'power') {
            for (const entry of definitionEntries(node)) {
                const name = display(entry.lora);
                if (!name || /^None$/i.test(name)) continue;
                if (entry.on === false) continue;
                const model = entry.strength;
                const clip = entry.strengthTwo == null ? entry.strength : entry.strengthTwo;
                if (Number(model) === 0 && Number(clip) === 0) continue;
                items.push({ name, text: formatLora(name, model, clip) });
            }
            return items;
        }
        if (spec.kind === 'pairs') {
            for (let index = 1; index <= 4; index += 1) {
                const suffix = String(index).padStart(2, '0');
                const name = display(node.inputs[`lora_${suffix}`]);
                if (!name || /^None$/i.test(name)) continue;
                const strength = display(node.inputs[`strength_${suffix}`]);
                if (Number(strength) === 0) continue;
                items.push({ name, text: formatLora(name, strength) });
            }
            return items;
        }
        // kind === 'efficiency': only the rows up to lora_count are real.
        const count = Math.min(Math.max(Number(inputValue(node, 'lora_count')) || 0, 0), 50);
        const mode = String(inputValue(node, 'input_mode') || 'simple').toLowerCase();
        for (let index = 1; index <= count; index += 1) {
            const name = display(node.inputs[`lora_name_${index}`]);
            if (!name || /^None$/i.test(name)) continue;
            const model = display(node.inputs[`model_str_${index}`]);
            const clip = display(node.inputs[`clip_str_${index}`]);
            const weight = display(node.inputs[`lora_wt_${index}`]);
            if (mode === 'simple') {
                const strength = weight || model;
                if (Number(strength) === 0) continue;
                items.push({ name, text: formatLora(name, strength) });
            } else {
                if (Number(model) === 0 && Number(clip) === 0) continue;
                items.push({ name, text: formatLora(name, model, clip) });
            }
        }
        return items;
    }
    const NAMED_DELIMITERS = Object.freeze({ none: '', space: ' ', comma: ', ', newline: '\n', 'new line': '\n' });

    // Keys an unknown node may use to hold prompt text (catalogue §4.1).
    const GENERIC_TEXT_KEYS = new Set(['text', 'prompt', 'value', 'string']);

    const NON_TEXT_VALUE = /^(?:-?\d+(?:\.\d+)?|true|false)$/i;

    function genericTextField(node) {
        const inputs = node.inputs || {};
        for (const key in inputs) {
            if (!GENERIC_TEXT_KEYS.has(key.toLowerCase())) continue;
            const raw = inputs[key];
            if (raw == null || Array.isArray(raw)) continue;
            const value = display(raw);
            if (value && !NON_TEXT_VALUE.test(value)) return value;
        }
        return '';
    }

    function resolveLinkedField(graph, node, field, ctx) {
        const raw = node.inputs[field];
        if (raw == null) return '';
        if (Array.isArray(raw)) {
            if (raw.length < 1) return '';
            const originId = String(raw[0]);
            if (!graph.nodes.has(originId)) return '';
            return resolveNodeText(graph.nodes.get(originId), ctx);
        }
        return display(raw);
    }

    function delimiterFor(node, resolver, ctx) {
        const field = resolver.delimiterField || 'delimiter';
        const raw = node.inputs[field];
        const text = Array.isArray(raw)
            ? resolveLinkedField(ctx.graph, node, field, ctx)
            : (raw == null ? '' : String(raw));
        if (resolver.delimiterMode === 'named') {
            return Object.prototype.hasOwnProperty.call(NAMED_DELIMITERS, text.toLowerCase())
                ? NAMED_DELIMITERS[text.toLowerCase()]
                : text;
        }
        if (text) return text;
        return resolver.defaultDelimiter == null ? '' : resolver.defaultDelimiter;
    }

    function resolverParts(node, resolver) {
        if (Array.isArray(resolver.parts)) return resolver.parts;
        if (!resolver.partsPattern) return [];
        const pattern = new RegExp(resolver.partsPattern);
        const keys = Object.keys(node.inputs || {}).filter(key => pattern.test(key));
        if (resolver.sort === 'numeric') {
            const number = key => {
                const match = key.match(/\d+/);
                return match ? Number(match[0]) : 0;
            };
            keys.sort((a, b) => number(a) - number(b));
        } else {
            keys.sort();
        }
        return keys;
    }

    function resolveNodeText(node, ctx) {
        const graph = ctx.graph;
        const resolver = node.resolver || null;
        const fields = resolver ? null : legacyEncoderFields(node);
        if (!resolver && !fields) return '';
        if (ctx.seen.has(node.id) || ctx.depth >= MAX_TEXT_DEPTH) return '';
        ctx.seen.add(node.id);
        ctx.depth += 1;
        try {
            if (resolver && resolver.role === 'concat') {
                const values = [];
                for (const part of resolverParts(node, resolver)) {
                    const value = resolveLinkedField(graph, node, part, ctx);
                    if (value) values.push(value);
                }
                if (values.length === 0) return '';
                ctx.consumed.add(node.id);
                return values.join(delimiterFor(node, resolver, ctx));
            }
            const values = [];
            for (const field of (resolver ? resolver.fields : fields)) {
                const value = resolveLinkedField(graph, node, field, ctx);
                if (value && !values.includes(value)) values.push(value);
            }
            if (values.length === 0) return '';
            ctx.consumed.add(node.id);
            if (resolver && resolver.prefer) return values[0];
            return values.join(resolver ? resolver.join : '\n');
        } finally {
            ctx.depth -= 1;
            ctx.seen.delete(node.id);
        }
    }

    function createTextContext(graph) {
        return { graph, depth: 0, seen: new Set(), consumed: new Set() };
    }

    const PORT_SEMANTICS = [
        ['positive', /^(?:positive|pos|conditioning\+|conditioning_positive|cond_?positive)$/],
        ['negative', /^(?:negative|neg|conditioning-|conditioning_negative|cond_?negative)$/],
    ];

    function portSemantic(name) {
        const normalized = String(name || '').trim().toLowerCase();
        if (!normalized) return '';
        for (const [semantic, pattern] of PORT_SEMANTICS) {
            if (pattern.test(normalized)) return semantic;
        }
        return '';
    }

    // A declared output that is clearly not conditioning (MODEL/VAE/CLIP/...)
    // means the port does not carry prompt text at all.
    const NON_PROMPT_OUTPUT = /^(?:model|clip|vae|latent|image|mask|sigmas|guider|sampler|lora_?stack|control_net|noise|audio|video)$/i;

    // API prompts carry no output metadata, so slot meaning comes from this
    // table ("class_type" is the key, slots are CONDITIONING+/- order). Only
    // verified schemas are listed: a missing entry falls back to the safe
    // rules below, and nothing is guessed from link order.
    const OUTPUT_SLOTS = new Map();

    function registerOutputSlots(type, slots) {
        const key = normalizeResolverType(type);
        if (!key || !Array.isArray(slots) || slots.length === 0) return false;
        OUTPUT_SLOTS.set(key, slots.map(slot => String(slot || 'other').toLowerCase()));
        return true;
    }

    const BUILTIN_OUTPUT_SLOTS = [
        // MODEL, CONDITIONING+, CONDITIONING-, LATENT, VAE, CLIP, DEPENDENCIES
        ['Efficient Loader', ['other', 'positive', 'negative', 'other', 'other', 'other', 'other']],
        // PIPE_LINE, MODEL, VAE, CLIP, positive, negative, LATENT
        ['easy fullLoader', ['other', 'other', 'other', 'other', 'positive', 'negative', 'other']],
    ];
    BUILTIN_OUTPUT_SLOTS.forEach(([type, slots]) => registerOutputSlots(type, slots));

    function inboundForOutput(graph, nodeId, outputSlot, portName = '') {
        const links = graph.inbound.get(String(nodeId)) || [];
        const slot = outputSlot == null || outputSlot === '' ? null : Number(outputSlot);
        const hasSlot = Number.isSafeInteger(slot) && slot >= 0;

        const node = graph.nodes.get(String(nodeId));
        const outputs = Array.isArray(node?.raw?.outputs) ? node.raw.outputs : [];
        const conditioningLinks = links.filter(link => portSemantic(link.name));

        if (hasSlot && outputs.length > 0) {
            const output = outputs.find((item, index) => {
                const indexValue = Number(item?.slot_index ?? index);
                return Number.isSafeInteger(indexValue) && indexValue === slot;
            });
            const declared = String(output?.name || output?.label || '').trim();
            const semantic = portSemantic(declared);
            if (semantic) {
                return links.filter(link => portSemantic(link.name) === semantic);
            }
            if (declared && NON_PROMPT_OUTPUT.test(declared)) return [];
            // Generic "CONDITIONING" outputs on nodes that expose exactly one
            // port per side keep their declared order.
            if (conditioningLinks.length > 1 && slot < conditioningLinks.length) {
                return [conditioningLinks[slot]];
            }
            return links;
        }

        // Verified API-format schema: the slot index decides the role.
        const slots = OUTPUT_SLOTS.get(normalizeResolverType(node?.type));
        if (slots && hasSlot) {
            const semantic = slots[slot] || 'other';
            if (semantic === 'positive' || semantic === 'negative') {
                return links.filter(link => portSemantic(link.name) === semantic);
            }
            return [];
        }

        // Unknown schema: a single named conditioning port is still
        // unambiguous; anything else is left unresolved instead of being
        // guessed by link order (that guess is what swapped positive and
        // negative through loaders such as Efficiency Nodes' Efficient Loader).
        if (conditioningLinks.length === 1) {
            return portName && portSemantic(conditioningLinks[0].name) === portName
                ? [conditioningLinks[0]]
                : [];
        }
        if (conditioningLinks.length > 1) return [];
        if (links.length === 1) return links;
        if (!hasSlot || slot === 0) return links;
        return [];
    }

    function textNodesFrom(graph, startId, outputSlot, budget, portName = '') {
        const found = [];
        const seen = new Set();
        const foundSeen = new Set();
        const promptNodeIds = new Set();
        const stack = [{ id: String(startId), outputSlot, portName }];
        while (stack.length && seen.size < MAX_NODES && consumeGraphWork(budget)) {
            const current = stack.pop();
            const id = current.id;
            const visitKey = `${id}\0${current.outputSlot == null ? '*' : String(current.outputSlot)}`;
            if (seen.has(visitKey) || !graph.nodes.has(id)) continue;
            seen.add(visitKey);
            const node = graph.nodes.get(id);
            let text = '';
            if (isTextCarrier(node)) {
                const ctx = createTextContext(graph);
                text = resolveNodeText(node, ctx);
                for (const consumedId of ctx.consumed) promptNodeIds.add(consumedId);
            } else {
                // Catalogue §4.1: an unknown node holding prompt text in a
                // known key is adopted only when it was reached through a
                // known consumer (that is how we got here).
                text = genericTextField(node);
            }
            if (text) {
                promptNodeIds.add(id);
                if (!addUniqueBounded(found, foundSeen, { label: node.title, text }, budget)) break;
                continue;
            }
            for (const link of inboundForOutput(graph, id, current.outputSlot, current.portName)) {
                if (!consumeGraphWork(budget)) break;
                stack.push({ id: link.originId, outputSlot: link.originSlot, portName: '' });
            }
        }
        if (stack.length && seen.size >= MAX_NODES) budget.exhausted = true;
        return { entries: found, promptNodeIds };
    }

    function analyzeGraph(graphValue, graphLabel) {
        const graph = normalizeGraph(graphValue);
        if (!graph) return null;
        const allNodes = Array.from(graph.nodes.values());
        let outputs = allNodes.filter(node => OUTPUT_TYPE.test(node.type));
        if (outputs.length === 0) outputs = allNodes.filter(node => SAMPLER_TYPE.test(node.type));
        if (outputs.length === 0) outputs = [{ id: '__all__', title: 'Workflow', type: 'Workflow' }];

        const budget = { remaining: MAX_GRAPH_WORK, exhausted: false };
        const result = { positive: [], negative: [], unconnected: [], models: [], loras: [], grid: [], limited: graph.limited || outputs.length > MAX_SUMMARY_OUTPUTS };
        const gridSeen = new Set();
        const addGrid = (key, value) => {
            const text = display(value);
            const token = `${key}\0${text}`;
            if (!text || gridSeen.has(token)) return;
            if (result.grid.length >= MAX_SUMMARY_ITEMS) {
                budget.exhausted = true;
                return;
            }
            gridSeen.add(token);
            result.grid.push({ key, value: text });
        };

        const resultSeen = Object.fromEntries(['positive', 'negative', 'unconnected', 'models', 'loras'].map(key => [key, new Set()]));
        // LoRAs are a set, not per-output data: the same loader can sit behind
        // several SaveImage/PreviewImage nodes.
        const loraTexts = new Set();
        const connectedPromptIds = new Set();
        for (const [outputIndex, output] of outputs.slice(0, MAX_SUMMARY_OUTPUTS).entries()) {
            if (!consumeGraphWork(budget)) break;
            const scope = output.id === '__all__' ? new Set(graph.nodes.keys()) : ancestors(graph, output.id, budget);
            const label = outputs.length > 1 ? (output.title || output.type || `Output ${outputIndex + 1}`) : (output.title || graphLabel || 'Workflow');
            const samplers = [];
            for (const id of scope) {
                if (!consumeGraphWork(budget)) break;
                const node = graph.nodes.get(id);
                if (node && SAMPLER_TYPE.test(node.type)) samplers.push(node);
            }
            const positive = [];
            const negative = [];
            const positiveSeen = new Set();
            const negativeSeen = new Set();
            for (const sampler of samplers) {
                if (!consumeGraphWork(budget)) break;
                const links = graph.inbound.get(sampler.id) || [];
                for (const port of ['positive', 'negative']) {
                    for (const link of links) {
                        if (!consumeGraphWork(budget)) break;
                        if (link.name.toLowerCase() !== port) continue;
                        const traversal = textNodesFrom(graph, link.originId, link.originSlot, budget, port);
                        for (const id of traversal.promptNodeIds) connectedPromptIds.add(id);
                        const entries = traversal.entries;
                        const destination = port === 'positive' ? positive : negative;
                        const destinationSeen = port === 'positive' ? positiveSeen : negativeSeen;
                        for (const entry of entries) {
                            if (!addUniqueBounded(destination, destinationSeen, entry, budget)) break;
                        }
                        if (budget.exhausted) break;
                    }
                    if (budget.exhausted) break;
                }
                const addSamplerValue = (keys, label) => {
                    for (const key of keys) {
                        if (!consumeGraphWork(budget)) return;
                        const value = inputValue(sampler, key);
                        if (value) addGrid(label || key, value);
                    }
                };
                addSamplerValue(['seed', 'noise_seed'], 'Seed');
                addSamplerValue(['steps'], 'Steps');
                addSamplerValue(['cfg'], 'CFG');
                addSamplerValue(['sampler_name'], 'Sampler');
                addSamplerValue(['scheduler'], 'Scheduler');
                addSamplerValue(['denoise'], 'Denoise');
                if (budget.exhausted) break;
            }

            for (const item of positive) {
                addUniqueBounded(result.positive, resultSeen.positive, { label, text: item.text }, budget);
                if (budget.exhausted) break;
            }
            for (const item of negative) {
                addUniqueBounded(result.negative, resultSeen.negative, { label, text: item.text }, budget);
                if (budget.exhausted) break;
            }

            for (const id of scope) {
                if (!consumeGraphWork(budget)) break;
                const node = graph.nodes.get(id);
                if (!node) continue;
                if (MODEL_TYPE.test(node.type)) {
                    const model = inputValue(node, 'ckpt_name', 'model_name', 'unet_name', 'model', 'filename');
                    if (model) {
                        addUniqueBounded(result.models, resultSeen.models, { label, text: model }, budget);
                        addGrid('Model', model);
                    }
                }
                if (LORA_TYPE.test(node.type) || loraResolverFor(node.type)) {
                    for (const lora of lorasFor(node)) {
                        if (!loraTexts.has(lora.text)) {
                            loraTexts.add(lora.text);
                            addUniqueBounded(result.loras, resultSeen.loras, { label, text: lora.text }, budget);
                        }
                        addGrid('LoRA', lora.text);
                        if (budget.exhausted) break;
                    }
                }
                if (budget.exhausted) break;
            }
            if (budget.exhausted) break;
        }

        // Keep prompt nodes that do not feed a sampler's positive/negative input
        // visible, with an explicit unconnected classification in the UI.
        for (const node of allNodes) {
            if (!consumeGraphWork(budget)) break;
            if (connectedPromptIds.has(node.id)) continue;
            let text = '';
            if (isTextCarrier(node)) {
                const ctx = createTextContext(graph);
                text = resolveNodeText(node, ctx);
            } else {
                text = genericTextField(node);
            }
            if (text) addUniqueBounded(result.unconnected, resultSeen.unconnected, { label: node.title, text }, budget);
        }
        if (budget.exhausted) result.limited = true;
        return result;
    }

    const NEGATIVE_MARKER = 'Negative prompt:';
    const SETTINGS_MARKER = /(?:^|\n)\s*Steps:\s*\d/;

    /**
     * Interpret an A1111-style `parameters` carrier.
     *
     * ComfyUI saver nodes (SD Prompt Saver, Inspire's SaveImage, ...) often
     * write this carrier even though the graph itself has no literal prompt
     * text. Returns null when the value is not a plain-text A1111 record.
     *
     * @param {*} value - raw `parameters` chunk value
     * @returns {{positive:string, negative:string, settings:string}|null}
     */
    function parseA1111Parameters(value) {
        if (typeof value !== 'string') return null;
        const text = value.trim();
        if (!text) return null;
        // JSON carriers (SwarmUI, ComfyUI-Efficiency generation data) are
        // handled elsewhere; do not split them as prose.
        if (text[0] === '{' || text[0] === '[') return null;
        const negativeIndex = text.indexOf(NEGATIVE_MARKER);
        const settingsMatch = text.match(SETTINGS_MARKER);
        const settingsIndex = settingsMatch ? settingsMatch.index + (settingsMatch[0].startsWith('\n') ? 1 : 0) : -1;
        if (negativeIndex < 0 && settingsIndex < 0) return null;
        const bodyEnd = settingsIndex >= 0 ? settingsIndex : text.length;
        const positive = negativeIndex >= 0
            ? text.slice(0, Math.min(negativeIndex, bodyEnd)).trim()
            : text.slice(0, bodyEnd).trim();
        const negative = negativeIndex >= 0 && negativeIndex < bodyEnd
            ? text.slice(negativeIndex + NEGATIVE_MARKER.length, bodyEnd).trim()
            : '';
        const settings = settingsIndex >= 0 ? text.slice(settingsIndex).trim() : '';
        if (!positive && !negative) return null;
        return { positive, negative, settings };
    }

    function summarize(sourceValue) {
        const source = sourceValue && typeof sourceValue === 'object' ? sourceValue : {};
        const graphs = [
            ['API Prompt', source.prompt],
            ['Workflow', source.workflow],
            ['Generation Data', source.generation_data],
        ];
        const summary = {
            positive: [], negative: [], unconnected: [], models: [], loras: [], grid: [], limited: false,
            // Set only when the graph yields no prompt at all and the
            // `parameters` carrier can be read instead. Consumers must show its
            // origin explicitly instead of passing it off as graph prompts.
            fallback: null,
        };
        const seen = new Set();
        const entrySeen = Object.fromEntries(['positive', 'negative', 'unconnected', 'models', 'loras'].map(key => [key, new Set()]));
        for (const [label, value] of graphs) {
            if (value == null || value === '') continue;
            const parsed = parseJson(value) || value;
            const graphSummary = analyzeGraph(parsed, label);
            if (!graphSummary) continue;
            if (graphSummary.limited) summary.limited = true;
            for (const key of ['positive', 'negative', 'unconnected', 'models', 'loras']) {
                for (const item of graphSummary[key]) {
                    const token = `${item.label}\0${item.text}`;
                    if (entrySeen[key].has(token)) continue;
                    if (summary[key].length >= MAX_SUMMARY_ITEMS) {
                        summary.limited = true;
                        break;
                    }
                    entrySeen[key].add(token);
                    summary[key].push(item);
                }
            }
            for (const row of graphSummary.grid) {
                const token = `${row.key}\0${row.value}`;
                if (!seen.has(token)) {
                    if (summary.grid.length >= MAX_SUMMARY_ITEMS) {
                        summary.limited = true;
                        break;
                    }
                    seen.add(token);
                    summary.grid.push(row);
                }
            }
        }
        if (typeof source.prompt === 'string') {
            const parsed = parseJson(source.prompt);
            const text = source.prompt.trim();
            const looksLikeStructuredPayload = /^[{[]/.test(text);
            if (!parsed && !looksLikeStructuredPayload && text && !summary.positive.some(entry => entry.text === text)) {
                if (summary.positive.length < MAX_SUMMARY_ITEMS) summary.positive.push({ label: 'Prompt', text });
                else summary.limited = true;
            }
        }
        if (source.negative_prompt != null) {
            const negative = display(source.negative_prompt);
            if (negative && !summary.negative.some(entry => entry.text === negative)) {
                if (summary.negative.length < MAX_SUMMARY_ITEMS) summary.negative.push({ label: 'Negative Prompt', text: negative });
                else summary.limited = true;
            }
        }
        if (source.model != null) {
            const model = display(source.model);
            if (model && !summary.models.some(entry => entry.text === model)) {
                if (summary.models.length < MAX_SUMMARY_ITEMS) summary.models.push({ label: 'Metadata', text: model });
                else summary.limited = true;
                if (!summary.grid.some(row => row.key === 'Model' && row.value === model)) {
                    if (summary.grid.length < MAX_SUMMARY_ITEMS) summary.grid.push({ key: 'Model', value: model });
                    else summary.limited = true;
                }
            }
        }
        if (summary.positive.length === 0 && summary.negative.length === 0) {
            const fallback = parseA1111Parameters(source.parameters);
            if (fallback) {
                summary.fallback = {
                    source: 'parameters',
                    format: 'a1111',
                    reason: 'graph-prompts-unresolved',
                    positive: fallback.positive,
                    negative: fallback.negative,
                    settings: fallback.settings,
                };
            }
        }
        return summary;
    }

    const api = {
        normalizeGraph, summarize, parseA1111Parameters,
        registerTextResolver, resetTextResolvers,
        registerOutputSlots, registerLoraResolver, resetLoraResolvers,
    };
    root.ComfyUIParser = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
