// Direct ComfyUI POST bridge. Loads a workflow JSON file, replaces
// %prompt%/%negative_prompt%/%width%/%height%/%steps%/%denoise%, randomizes
// seed (or uses provided), POSTs to /prompt, polls /history, returns image URL.
//
// Workflows are file-system files referenced by smart-phone settings.
// We fetch them via fetch('file://...') is blocked in browser, so instead
// we expect ST to have them addressable via HTTP path (we'll let user paste
// the workflow JSON inline in settings as fallback).
//
// Better approach: use ST's `/api/files` if available; otherwise read raw text
// from a path the user pastes. For now expose three paths to settings and let
// fetch try via plain fetch (works if ST's static server includes them).
//
// NOTE: We CANNOT fetch arbitrary g:/ paths from a browser-bound extension.
// So we mirror the workflow JSONs into the extension dir at install time, OR
// we let the user paste workflow content directly.
//
// Strategy adopted: bundle the 3 workflow templates inside the extension as
// JS modules (workflows.js) so we don't need any file fetching. Users can
// override paths in settings if they want different workflows.

import { workflowTemplates } from './workflows.js';

const NODE_IDS = {
    pony:    { positive: '7', negative: '8', latent: '9', sampler: '10' },
    noobai:  { positive: '7', negative: '8', latent: '9', sampler: '10' },
    majicmix:{ positive: '7', negative: '8', latent: '9', sampler: '10' },
};

export class ComfyUIBridge {
    constructor({ baseUrl = 'http://127.0.0.1:8188' } = {}) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.clientId = `smart-imgen-${Math.random().toString(36).slice(2, 10)}`;
    }

    async generate({ model = 'pony', positive, negative, width, height, steps = 30, cfg, sampler, scheduler, seed = null, denoise = 1.0 }) {
        const tpl = workflowTemplates[model];
        if (!tpl) throw new Error(`Unknown model: ${model}`);
        const wf = JSON.parse(JSON.stringify(tpl));

        const ids = NODE_IDS[model] || NODE_IDS.pony;
        wf[ids.positive].inputs.text = positive;
        wf[ids.negative].inputs.text = negative;
        wf[ids.latent].inputs.width = width;
        wf[ids.latent].inputs.height = height;
        wf[ids.sampler].inputs.steps = steps;
        wf[ids.sampler].inputs.denoise = denoise;
        if (cfg !== undefined) wf[ids.sampler].inputs.cfg = cfg;
        if (sampler) wf[ids.sampler].inputs.sampler_name = sampler;
        if (scheduler) wf[ids.sampler].inputs.scheduler = scheduler;
        wf[ids.sampler].inputs.seed = seed ?? randomSeed();

        const promptId = await this.queue(wf);
        const result = await this.waitFor(promptId);
        const out = pickOutputImage(result);
        if (!out) throw new Error('ComfyUI returned no image');

        return {
            imageUrl: this.viewUrl(out),
            seed: wf[ids.sampler].inputs.seed,
        };
    }

    async queue(wf) {
        const resp = await fetch(`${this.baseUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: wf, client_id: this.clientId }),
        });
        if (!resp.ok) throw new Error(`ComfyUI /prompt ${resp.status}: ${await resp.text()}`);
        const data = await resp.json();
        if (!data.prompt_id) throw new Error('ComfyUI did not return prompt_id');
        return data.prompt_id;
    }

    async waitFor(promptId, { intervalMs = 1500, timeoutMs = 180_000 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const resp = await fetch(`${this.baseUrl}/history/${promptId}`);
            if (resp.ok) {
                const data = await resp.json();
                const entry = data[promptId];
                if (entry?.status?.completed) return entry;
                if (entry?.status?.status_str === 'error') {
                    throw new Error('ComfyUI generation error: ' + JSON.stringify(entry.status));
                }
            }
            await sleep(intervalMs);
        }
        throw new Error('ComfyUI generation timed out');
    }

    viewUrl({ filename, subfolder = '', type = 'output' }) {
        const params = new URLSearchParams({ filename, subfolder, type });
        return `${this.baseUrl}/view?${params.toString()}`;
    }
}

function pickOutputImage(historyEntry) {
    const outputs = historyEntry.outputs || {};
    for (const nodeOut of Object.values(outputs)) {
        if (Array.isArray(nodeOut.images) && nodeOut.images.length) {
            return nodeOut.images[nodeOut.images.length - 1];
        }
    }
    return null;
}

function randomSeed() {
    // ComfyUI seed is uint64; JS safely handles up to 2^53
    return Math.floor(Math.random() * 0xfffffffff);
}

function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
}
