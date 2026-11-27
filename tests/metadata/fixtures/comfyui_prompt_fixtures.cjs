/*
 * ComfyUI prompt-detection fixtures.
 *
 * These are trimmed, structure-faithful reductions of real metadata carriers.
 * Prompt *text* is synthetic on purpose: the shapes (multi-line prompt, artist
 * weights, "Negative prompt:" block, JPS concatenation chain, Efficient Loader
 * STRING ports, SDPromptReader round-trip) are what the parser must handle.
 *
 * Run together with the metadata tests:
 *   node --test tests/metadata/*.test.cjs
 */
'use strict';

/**
 * A1111-style `parameters` chunk as written by SD Prompt Saver from a
 * ComfyUI graph (the original image's carrier, text replaced with neutral
 * content of the same shape).
 */
const A1111_PARAMETERS = `masterpiece, best quality, amazing quality, very aesthetic, absurdres
(artist_a:0.65),(artist_b:0.5),(artist_c:0.15),(artist_d:0.35),
(aged down,petite:1.45)
, depth of field,(indoors), ,blue sky,palm tree
((living room)),french ,windows,room,curtains,wall,shelf,plant
sitting,white sofa
side view,holding cup,glass,drinking
profile
1girl,white bonnet
character_x,white dress, pink bow, blonde hair, long hair, twintails,elbow gloves, purple eyes, rabbit hair ornament, very long hair, white pantyhose
,dutch angle,

Negative prompt: bad quality,worst quality,worst detail,sketch,censor,,watermark,, long leg,long legs ,long body,shiny skin,bad hands,mutate hands,6 fingers,6 toes,many fingers,extra ,multiple boys,multiple girls,chibi, doll,(mature female)
,wide shot,full body,full shot,hood up,mature female,yellow lights
Steps: 20, Sampler: euler_simple, CFG scale: 8.0, Seed: 1051347665780460, Size: 1024x1024, Model hash: a5f58eb1c3, Model: waiIllustriousSDXL_v160, VAE hash: 235745af8d, VAE: sdxl.vae, Version: ComfyUI, Hashes: {"model": "a5f58eb1c3", "vae": "235745af8d"}`;

/**
 * The expected split of A1111_PARAMETERS. Kept next to the fixture so tests do
 * not re-implement the delimiter rules they are checking.
 */
const A1111_EXPECTED = {
    positive: A1111_PARAMETERS.slice(0, A1111_PARAMETERS.indexOf('Negative prompt:')).trim(),
    negative: A1111_PARAMETERS
        .slice(A1111_PARAMETERS.indexOf('Negative prompt:') + 'Negative prompt:'.length,
            A1111_PARAMETERS.indexOf('Steps:'))
        .trim(),
    settings: A1111_PARAMETERS.slice(A1111_PARAMETERS.indexOf('Steps:')).trim(),
};

/** No metadata at all: the UI still runs and must stay cheap. */
function emptyMetadata() {
    return {};
}

/**
 * The common happy path: literal prompts on CLIPTextEncode, wired straight
 * into a sampler. This is the regression guard for the resolver table.
 */
function plainClipTextEncodeMetadata() {
    return {
        prompt: {
            '6': { class_type: 'CLIPTextEncode', inputs: { text: 'masterpiece, 1girl, solo, beach', clip: ['4', 1] } },
            '7': { class_type: 'CLIPTextEncode', inputs: { text: 'bad quality, watermark, text', clip: ['4', 1] } },
            '3': {
                class_type: 'KSampler',
                inputs: {
                    seed: 12345, steps: 20, cfg: 8, sampler_name: 'euler', scheduler: 'simple',
                    denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
                },
            },
            '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
            '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
            '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] } },
            '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
        },
    };
}

/**
 * Reduced graph of the analysed PNG (18 of the 42 executed nodes).
 *
 * The prompt text never reaches a CLIPTextEncode: it is concatenated by
 * "Text Concatenate (JPS)" and consumed by "Efficient Loader" STRING ports,
 * while the upscale pass re-reads the prompt from the input image through
 * "SD Prompt Reader". The saved PNG therefore only carries the answer in its
 * `parameters` chunk.
 */
function jpsEfficientLoaderMetadata() {
    return {
        parameters: A1111_PARAMETERS,
        prompt: {
            '4': {
                class_type: 'Text Prompt (JPS)',
                inputs: { text: 'bad quality,worst quality,worst detail,sketch,censor,,watermark,, bad hands,bad anatomy' },
            },
            '13': {
                class_type: 'Text Prompt (JPS)',
                inputs: { text: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres\n(artist_a:0.45),(artist_b:0.35)' },
            },
            '187': {
                class_type: 'Text Prompt (JPS)',
                inputs: { text: 'living room,white sofa,curtains,plant,dutch angle' },
            },
            '190': {
                class_type: 'ImpactWildcardProcessor',
                inputs: {
                    wildcard_text: '__1/02_angle__, __1/03_perspective__',
                    populated_text: 'dutch angle,dynamic angle,foreshortening',
                    mode: 'reproduce',
                    seed: 672859705335854,
                },
            },
            '192': { class_type: 'Text Concatenate (JPS)', inputs: { delimiter: 'comma', text1: ['190', 0] } },
            '5': {
                class_type: 'Text Concatenate (JPS)',
                inputs: { delimiter: 'comma', text1: ['13', 0], text3: ['187', 0], text5: ['192', 0] },
            },
            '253': {
                class_type: 'Efficient Loader',
                inputs: {
                    ckpt_name: 'waiIllustriousSDXL_v160.safetensors',
                    vae_name: 'Baked VAE',
                    clip_skip: -2,
                    lora_name: 'None',
                    lora_model_strength: 1,
                    lora_clip_strength: 1,
                    positive: ['5', 0],
                    negative: ['4', 0],
                    token_normalization: 'none',
                    weight_interpretation: 'comfy',
                    empty_latent_width: ['275', 0],
                    empty_latent_height: ['341', 0],
                    batch_size: 1,
                },
            },
            '275': { class_type: 'ImpactSwitch', inputs: { select: ['198', 2], sel_mode: false, input1: ['195', 0] } },
            '341': { class_type: 'ImpactSwitch', inputs: { select: ['198', 2], sel_mode: false, input1: ['195', 1] } },
            '198': { class_type: 'Random Number', inputs: { min: 1, max: 5, seed: 0 } },
            '195': { class_type: 'CM_SDXLResolution', inputs: { resolution: '1024x1024' } },
            '254': {
                class_type: 'KSampler //Inspire',
                inputs: {
                    seed: 162004018386013, steps: 16, cfg: 2.5, sampler_name: 'dpmpp_2m_sde', scheduler: 'karras',
                    denoise: 1, noise_mode: 'CPU', batch_seed_mode: 'incremental',
                    model: ['221', 0], positive: ['253', 1], negative: ['253', 2], latent_image: ['253', 3],
                },
            },
            '221': {
                class_type: 'Power Lora Loader (rgthree)',
                inputs: {
                    PowerLoraLoaderHeaderWidget: { type: 'PowerLoraLoaderHeaderWidget' },
                    lora_1: { on: false, lora: 'style.safetensors', strength: 0.6 },
                    lora_2: { on: true, lora: 'lighting.safetensors', strength: 1 },
                    model: ['253', 0],
                },
            },
            '257': {
                class_type: 'UltimateSDUpscale',
                inputs: {
                    upscale_by: 1.5, seed: 716618653498403, steps: 14, cfg: 3.5, sampler_name: 'euler',
                    scheduler: 'karras', denoise: 0.32, mode_type: 'Linear', tile_width: ['265', 0],
                    tile_height: ['264', 0], mask_blur: 8, tile_padding: 8, image: ['259', 0], model: ['308', 0],
                    positive: ['260', 0], negative: ['261', 0], vae: ['253', 4], upscale_model: ['81', 0],
                },
            },
            '265': { class_type: 'MathExpression|pysssss', inputs: { a: 1024, b: 8, expression: 'a/b' } },
            '264': { class_type: 'MathExpression|pysssss', inputs: { a: 1024, b: 8, expression: 'a/b' } },
            '308': { class_type: 'Power Lora Loader (rgthree)', inputs: { lora_1: { on: true, lora: 'lighting.safetensors', strength: 1 }, model: ['253', 0] } },
            '81': { class_type: 'UpscaleModelLoader', inputs: { model_name: '4x-UltraSharp.pth' } },
            '260': { class_type: 'CLIPTextEncode', inputs: { text: ['280', 0], clip: ['253', 5] } },
            '261': { class_type: 'CLIPTextEncode', inputs: { text: ['281', 0], clip: ['253', 5] } },
            '280': { class_type: 'Text Concatenate (JPS)', inputs: { delimiter: 'comma', text1: ['259', 2], text2: ['279', 0] } },
            '281': { class_type: 'Text Concatenate (JPS)', inputs: { delimiter: 'comma', text1: ['259', 3], text2: ['278', 0] } },
            '279': { class_type: 'Text Prompt (JPS)', inputs: { text: '' } },
            '278': { class_type: 'Text Prompt (JPS)', inputs: { text: '' } },
            '259': {
                class_type: 'SDPromptReader',
                inputs: { image: ['282', 0], parameter_index: ['282', 0] },
            },
            '282': { class_type: 'SDBatchLoader', inputs: { path: 'output/previous', image_load_limit: 0, start_index: 0 } },
            '299': {
                class_type: 'SDPromptSaver',
                inputs: {
                    filename: ['259', 10], path: 'T2i/Upscale/', model_name: 'waiIllustriousSDXL_v160.safetensors',
                    vae_name: 'sdxl.vae.safetensors', seed: 1051347665780460, steps: 20, cfg: 8, sampler_name: 'euler',
                    scheduler: 'simple', width: ['259', 7], height: ['259', 8], positive: ['259', 2],
                    negative: ['259', 3], extension: 'png', calculate_hash: true, images: ['257', 0],
                },
            },
        },
    };
}

/**
 * Synthetic graph that previously produced swapped labels: the sampler's
 * conditioning comes from an "Efficient Loader", whose output slots 1/2 are
 * CONDITIONING+/CONDITIONING-. API prompts carry no output metadata, so slot
 * meaning cannot be inferred from the inbound link order.
 */
function efficientLoaderSlotMetadata() {
    return {
        prompt: {
            '13': { class_type: 'CLIPTextEncode', inputs: { text: 'POSITIVE TEXT', clip: ['253', 5] } },
            '4': { class_type: 'CLIPTextEncode', inputs: { text: 'NEGATIVE TEXT', clip: ['253', 5] } },
            '253': {
                class_type: 'Efficient Loader',
                inputs: { ckpt_name: 'model.safetensors', positive: ['13', 0], negative: ['4', 0] },
            },
            '254': {
                class_type: 'KSampler',
                inputs: { seed: 1, steps: 20, cfg: 8, model: ['253', 0], positive: ['253', 1], negative: ['253', 2] },
            },
            '299': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['254', 0] } },
        },
    };
}

/**
 * Negative control: a ComfyUI graph without prompt text plus a `parameters`
 * carrier that is JSON (SwarmUI style). The A1111 fallback must not fire.
 */
function structuredParametersMetadata() {
    return {
        parameters: JSON.stringify({ sui_image_params: { prompt: 'swarm prompt', negativeprompt: 'swarm negative' } }),
        prompt: {
            '1': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
            '2': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['1', 0] } },
        },
    };
}


/**
 * Upscale-only remainder of the analysed graph plus the A1111 carrier.
 * `SDPromptReader` reads its prompt from another image at runtime, so the
 * graph itself resolves nothing and the `parameters` fallback must fire.
 */
function sdpromptReaderOnlyMetadata() {
    return {
        parameters: A1111_PARAMETERS,
        prompt: {
            '259': { class_type: 'SDPromptReader', inputs: { image: ['282', 0], parameter_index: 0 } },
            '282': { class_type: 'SDBatchLoader', inputs: { path: 'output/previous', image_load_limit: 0, start_index: 0 } },
            '280': { class_type: 'Text Concatenate (JPS)', inputs: { delimiter: 'comma', text1: ['259', 2], text2: ['279', 0] } },
            '281': { class_type: 'Text Concatenate (JPS)', inputs: { delimiter: 'comma', text1: ['259', 3], text2: ['278', 0] } },
            '279': { class_type: 'Text Prompt (JPS)', inputs: { text: '' } },
            '278': { class_type: 'Text Prompt (JPS)', inputs: { text: '' } },
            '260': { class_type: 'CLIPTextEncode', inputs: { text: ['280', 0], clip: ['253', 5] } },
            '261': { class_type: 'CLIPTextEncode', inputs: { text: ['281', 0], clip: ['253', 5] } },
            '257': {
                class_type: 'UltimateSDUpscale',
                inputs: { upscale_by: 1.5, seed: 1, steps: 14, cfg: 3.5, image: ['259', 0], model: ['308', 0], positive: ['260', 0], negative: ['261', 0], vae: ['253', 4] },
            },
            '308': { class_type: 'Power Lora Loader (rgthree)', inputs: { model: ['253', 0] } },
            '299': { class_type: 'SDPromptSaver', inputs: { positive: ['259', 2], negative: ['259', 3], images: ['257', 0] } },
        },
    };
}

/**
 * Unknown loader with positive/negative STRING inputs and no output schema.
 * Slot 1/2 could be anything, so both texts must stay unlabelled.
 */
function unknownLoaderMetadata() {
    return {
        prompt: {
            '13': { class_type: 'CLIPTextEncode', inputs: { text: 'POSITIVE TEXT' } },
            '4': { class_type: 'CLIPTextEncode', inputs: { text: 'NEGATIVE TEXT' } },
            '900': { class_type: 'Mystery Loader', inputs: { ckpt_name: 'model.safetensors', positive: ['13', 0], negative: ['4', 0] } },
            '254': { class_type: 'KSampler', inputs: { seed: 1, model: ['900', 0], positive: ['900', 1], negative: ['900', 2] } },
            '299': { class_type: 'SaveImage', inputs: { images: ['254', 0] } },
        },
    };
}

/** Impact wildcard: the populated text is what actually got encoded. */
function wildcardMetadata() {
    return {
        prompt: {
            '190': {
                class_type: 'ImpactWildcardProcessor',
                inputs: {
                    wildcard_text: '__artist__ __quality__, __pose__',
                    populated_text: 'artist_a, best quality, standing',
                    mode: 'populate',
                    seed: 672859705335854,
                },
            },
            '191': { class_type: 'Text Concatenate (JPS)', inputs: { delimiter: 'comma', text1: ['190', 0] } },
            '254': { class_type: 'KSampler', inputs: { seed: 1, positive: ['191', 0] } },
            '299': { class_type: 'SaveImage', inputs: { images: ['254', 0] } },
        },
    };
}

/**
 * Concatenation shapes: core StringConcatenate, KJ JoinStrings (default
 * space), WAS Text Concatenate (text_a..text_x) and JPS named delimiters.
 */
function concatMetadata() {
    return {
        prompt: {
            '1': { class_type: 'PrimitiveString', inputs: { value: 'core A' } },
            '2': { class_type: 'PrimitiveString', inputs: { value: 'core B' } },
            '3': { class_type: 'StringConcatenate', inputs: { string_a: ['1', 0], string_b: ['2', 0], delimiter: ' + ' } },
            '4': { class_type: 'CLIPTextEncode', inputs: { text: ['3', 0] } },

            '5': { class_type: 'StringConstant', inputs: { string: 'join A' } },
            '6': { class_type: 'StringConstant', inputs: { string: 'join B' } },
            '7': { class_type: 'JoinStrings', inputs: { string1: ['5', 0], string2: ['6', 0] } },
            '8': { class_type: 'CLIPTextEncode', inputs: { text: ['7', 0] } },

            '9': { class_type: 'Text Concatenate', inputs: { text_a: 'was A', text_b: 'was B', text_c: 'was C' } },
            '10': { class_type: 'CLIPTextEncode', inputs: { text: ['9', 0] } },

            '11': { class_type: 'Text Prompt (JPS)', inputs: { text: 'jps A' } },
            '12': { class_type: 'Text Prompt (JPS)', inputs: { text: 'jps B' } },
            '13': { class_type: 'Text Concatenate (JPS)', inputs: { delimiter: 'space', text1: ['11', 0], text2: ['12', 0] } },
            '14': { class_type: 'CLIPTextEncode', inputs: { text: ['13', 0] } },

            '20': {
                class_type: 'KSampler',
                inputs: {
                    seed: 1,
                    positive: ['4', 0],
                    negative: ['8', 0],
                },
            },
            '21': { class_type: 'KSampler', inputs: { seed: 2, positive: ['10', 0], negative: ['14', 0] } },
            '22': { class_type: 'SaveImage', inputs: { images: ['20', 0] } },
            '23': { class_type: 'SaveImage', inputs: { images: ['21', 0] } },
        },
    };
}

/** LoRA carriers that the old /LoraLoader/ regex missed. */
function loraMetadata() {
    return {
        prompt: {
            '1': {
                class_type: 'Power Lora Loader (rgthree)',
                inputs: {
                    lora_1: { on: false, lora: 'off.safetensors', strength: 1 },
                    lora_2: { on: true, lora: 'split.safetensors', strength: 0.6, strengthTwo: 0.4 },
                    lora_3: { on: true, lora: 'None', strength: 1 },
                    lora_4: { on: true, lora: 'zero.safetensors', strength: 0 },
                    lora_5: { on: true, lora: 'single.safetensors', strength: 0.8 },
                },
            },
            '2': {
                class_type: 'Lora Loader Stack (rgthree)',
                inputs: {
                    model: ['1', 0],
                    lora_01: 'stacked.safetensors', strength_01: 0.75,
                    lora_02: 'None', strength_02: 1,
                    lora_03: 'skipped.safetensors', strength_03: 0,
                },
            },
            '3': {
                class_type: 'LoRA Stacker',
                inputs: {
                    model: ['2', 0],
                    input_mode: 'simple', lora_count: 3,
                    lora_name_1: 'eff_a.safetensors', lora_wt_1: 0.5, model_str_1: 1, clip_str_1: 1,
                    lora_name_2: 'None', lora_wt_2: 1, model_str_2: 1, clip_str_2: 1,
                    lora_name_3: 'eff_b.safetensors', lora_wt_3: 1, model_str_3: 1, clip_str_3: 1,
                    lora_name_4: 'outside_count.safetensors', lora_wt_4: 1, model_str_4: 1, clip_str_4: 1,
                },
            },
            '4': {
                class_type: 'LoRA Stacker',
                inputs: {
                    model: ['3', 0],
                    input_mode: 'advanced', lora_count: 1,
                    lora_name_1: 'eff_adv.safetensors', lora_wt_1: 1, model_str_1: 0.7, clip_str_1: 0.3,
                },
            },
            '10': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
            '11': {
                class_type: 'KSampler',
                inputs: { seed: 1, model: ['4', 0], positive: ['1', 0] },
            },
            '12': { class_type: 'SaveImage', inputs: { images: ['11', 0] } },
        },
    };
}

/** easy fullLoader exposes positive/negative on slots 4/5. */
function easyLoaderSlotMetadata() {
    return {
        prompt: {
            '1': { class_type: 'PrimitiveString', inputs: { value: 'EASY POS' } },
            '2': { class_type: 'PrimitiveString', inputs: { value: 'EASY NEG' } },
            '3': {
                class_type: 'easy fullLoader',
                inputs: { ckpt_name: 'model.safetensors', positive: ['1', 0], negative: ['2', 0] },
            },
            '4': { class_type: 'KSampler', inputs: { seed: 1, model: ['3', 1], positive: ['3', 4], negative: ['3', 5] } },
            '5': { class_type: 'SaveImage', inputs: { images: ['4', 0] } },
        },
    };
}

module.exports = {
    A1111_PARAMETERS,
    A1111_EXPECTED,
    emptyMetadata,
    plainClipTextEncodeMetadata,
    jpsEfficientLoaderMetadata,
    efficientLoaderSlotMetadata,
    structuredParametersMetadata,
    sdpromptReaderOnlyMetadata,
    unknownLoaderMetadata,
    wildcardMetadata,
    concatMetadata,
    loraMetadata,
    easyLoaderSlotMetadata,
};
