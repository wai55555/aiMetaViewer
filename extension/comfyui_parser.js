/* Pure ComfyUI graph normalizer shared by metadata rendering and tests. */
(function (root) {
    'use strict';

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

    function parseJson(value) {
        if (typeof value !== 'string') return value;
        const text = value.trim();
        if (!text || (text[0] !== '{' && text[0] !== '[')) return null;
        try { return JSON.parse(text); } catch (_) { return null; }
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
        if (/^CheckpointLoaderSimple$/i.test(type)) names = ['ckpt_name'];
        else if (/LoraLoaderModelOnly/i.test(type)) names = ['lora_name', 'strength_model'];
        else if (/LoraLoader/i.test(type)) names = ['lora_name', 'strength_model', 'strength_clip'];
        else if (/KSamplerAdvanced/i.test(type)) names = ['add_noise', 'noise_seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'];
        else if (/KSampler/i.test(type)) names = ['seed', 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'];
        else if (/CLIPTextEncodeSDXL/i.test(type)) names = ['text_g', 'text_l', 'width', 'height', 'crop_w', 'crop_h', 'target_width', 'target_height'];
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
            const node = { id, raw, type: nodeType(raw), title: String(raw.title || raw.properties?.['Node name'] || nodeType(raw)), inputs: rawInputs };
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

    function textValue(node) {
        const direct = inputValue(node, 'text', 'prompt');
        if (direct) return direct;
        const parts = [
            inputValue(node, 'text_g', 'clip_g'),
            inputValue(node, 'text_l', 'clip_l'),
            inputValue(node, 't5xxl'),
        ].filter(Boolean);
        return Array.from(new Set(parts)).join('\n');
    }

    function textNodesFrom(graph, startId, budget) {
        const found = [];
        const seen = new Set();
        const foundSeen = new Set();
        const stack = [String(startId)];
        while (stack.length && seen.size < MAX_NODES && consumeGraphWork(budget)) {
            const id = stack.pop();
            if (seen.has(id) || !graph.nodes.has(id)) continue;
            seen.add(id);
            const node = graph.nodes.get(id);
            if (TEXT_TYPE.test(node.type)) {
                const text = textValue(node);
                if (text && !addUniqueBounded(found, foundSeen, { label: node.title, text }, budget)) break;
            }
            for (const link of graph.inbound.get(id) || []) {
                if (!consumeGraphWork(budget)) break;
                stack.push(link.originId);
            }
        }
        if (stack.length && seen.size >= MAX_NODES) budget.exhausted = true;
        if (found.length) return found;
        return [];
    }

    function uniqueEntries(items) {
        const seen = new Set();
        return items.filter(item => {
            const key = `${item.label}\0${item.text}`;
            if (!item.text || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    function analyzeGraph(graphValue, graphLabel) {
        const graph = normalizeGraph(graphValue);
        if (!graph) return null;
        const allNodes = Array.from(graph.nodes.values());
        let outputs = allNodes.filter(node => OUTPUT_TYPE.test(node.type));
        if (outputs.length === 0) outputs = allNodes.filter(node => SAMPLER_TYPE.test(node.type));
        if (outputs.length === 0) outputs = [{ id: '__all__', title: 'Workflow', type: 'Workflow' }];

        const budget = { remaining: MAX_GRAPH_WORK, exhausted: false };
        const result = { positive: [], negative: [], models: [], loras: [], grid: [], limited: outputs.length > MAX_SUMMARY_OUTPUTS };
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

        const resultSeen = Object.fromEntries(['positive', 'negative', 'models', 'loras'].map(key => [key, new Set()]));
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
                        const entries = textNodesFrom(graph, link.originId, budget);
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

            // If the graph has no sampler port labels, retain reachable text instead of losing it.
            if (positive.length === 0 && negative.length === 0) {
                for (const id of scope) {
                    if (!consumeGraphWork(budget)) break;
                    const node = graph.nodes.get(id);
                    if (!node || !TEXT_TYPE.test(node.type)) continue;
                    const text = textValue(node);
                    if (!text) continue;
                    const destination = /negative|undesired|\buc\b/i.test(node.title) ? negative : positive;
                    const destinationSeen = destination === negative ? negativeSeen : positiveSeen;
                    addUniqueBounded(destination, destinationSeen, { label: node.title, text }, budget);
                    if (budget.exhausted) break;
                }
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
                if (LORA_TYPE.test(node.type)) {
                    const name = inputValue(node, 'lora_name', 'adapter_name', 'filename');
                    const strength = inputValue(node, 'strength_model', 'strength');
                    if (name) {
                        const text = strength ? `${name} (${strength})` : name;
                        addUniqueBounded(result.loras, resultSeen.loras, { label, text }, budget);
                        addGrid('LoRA', text);
                    }
                }
                if (budget.exhausted) break;
            }
            if (budget.exhausted) break;
        }
        if (budget.exhausted) result.limited = true;
        return result;
    }

    function summarize(sourceValue) {
        const source = sourceValue && typeof sourceValue === 'object' ? sourceValue : {};
        const graphs = [
            ['API Prompt', source.prompt],
            ['Workflow', source.workflow],
            ['Generation Data', source.generation_data],
        ];
        const summary = { positive: [], negative: [], models: [], loras: [], grid: [], limited: false };
        const seen = new Set();
        const entrySeen = Object.fromEntries(['positive', 'negative', 'models', 'loras'].map(key => [key, new Set()]));
        for (const [label, value] of graphs) {
            if (value == null || value === '') continue;
            const parsed = parseJson(value) || value;
            const graphSummary = analyzeGraph(parsed, label);
            if (!graphSummary) continue;
            if (graphSummary.limited) summary.limited = true;
            for (const key of ['positive', 'negative', 'models', 'loras']) {
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
        return summary;
    }

    const api = { normalizeGraph, summarize };
    root.ComfyUIParser = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
