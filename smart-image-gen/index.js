// smart-image-gen: NSFW-aware image generation extension for SillyTavern.
//
// Public API exposed on window.smartImageGen:
//   - generateFromPicTag(picTag, { contacts, hint })   -> imageUrl
//   - generateReferenceImage({ characterName, anchorPrompt, existingSeed }) -> {imageUrl, seed}
//
// Behavior:
//   - Listens to MESSAGE_RECEIVED, finds <pic prompt="..."> tags in AI replies
//   - Looks at LAST USER MESSAGE for SFW/NSFW intent (this is the user's
//     pain point: "给我看看你的小穴" must add pussy/spread/close-up tags)
//   - Resolves character from contacts (smart-phone exposes window.smartPhone.getContacts)
//   - Routes to ComfyUI via direct POST with bundled workflow templates
//   - Replaces or attaches generated image to the message

import { extension_settings, getContext } from '../../../extensions.js';
import { eventSource, event_types, saveSettingsDebounced, updateMessageBlock } from '../../../../script.js';

import { classifyMessage, isNSFW } from './lib/nsfw-classifier.js';
import { buildPrompt, buildReferencePrompt, buildReferencePromptFull } from './lib/prompt-builder.js';
import { resolveContact, getAnchorBundle } from './lib/character-anchor.js';
import { ComfyUIBridge } from './lib/comfyui-bridge.js';

const EXT = 'smart-image-gen';

const defaults = {
    enabled: true,
    backend: 'comfyui',
    comfyuiUrl: 'http://127.0.0.1:8188',
    fallbackModel: 'pony',
    forceNsfwForExplicit: true,
    insertMode: 'replace', // replace | inline | new
};

$(function () {
    if (!extension_settings[EXT]) extension_settings[EXT] = structuredClone(defaults);
    for (const k of Object.keys(defaults)) {
        if (extension_settings[EXT][k] === undefined) extension_settings[EXT][k] = defaults[k];
    }

    injectMenuButton();
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

    console.log(`[${EXT}] loaded`);
});

function injectMenuButton() {
    if ($('#smart-image-gen-menu-btn').length) return;
    $('#extensionsMenu').append(`
        <div id="smart-image-gen-menu-btn" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-images"></div>
            <span>Smart Image Gen</span>
        </div>
    `);
    $('#smart-image-gen-menu-btn').on('click', () => {
        const s = extension_settings[EXT];
        s.enabled = !s.enabled;
        saveSettingsDebounced();
        toastr.info(`Smart Image Gen ${s.enabled ? '已启用' : '已禁用'}`);
    });
}

// ────────────────────────────────────────────────────────────────────
// Auto-process AI replies
// ────────────────────────────────────────────────────────────────────

const PIC_RE = /<pic[^>]*\sprompt="([^"]*)"[^>]*>/g;

async function onMessageReceived() {
    const s = extension_settings[EXT];
    if (!s.enabled) return;

    const ctx = getContext();
    const idx = ctx.chat.length - 1;
    const msg = ctx.chat[idx];
    if (!msg || msg.is_user) return;

    // Strip PHONE blocks before scanning — smart-phone's slot mechanism handles
    // <pic> tags inside <PHONE>; processing them here causes double-generation.
    const mesOutsidePhone = (msg.mes || '').replace(/<PHONE>[\s\S]*?<\/PHONE>/gi, '');
    const picMatches = [...mesOutsidePhone.matchAll(PIC_RE)];
    if (!picMatches.length) return;

    // Pull the last user message for intent classification
    const lastUser = findLastUserMessage(ctx.chat);
    const userText = lastUser?.mes || '';
    const intent = classifyMessage(userText);

    if (intent.level === 'explicit') {
        toastr.info(`检测到 NSFW 意图：${intent.tags.slice(0, 3).join(', ')}`);
    }

    const contacts = window.smartPhone?.getContacts?.() || [];
    const model = window.smartPhone?.getCurrentModel?.() || s.fallbackModel;
    const baseUrl = window.smartPhone?.getComfyuiUrl?.() || s.comfyuiUrl;
    const bridge = new ComfyUIBridge({ baseUrl });

    for (const m of picMatches) {
        const aiPrompt = m[1] || '';
        const tag = m[0];

        try {
            const contact = resolveContact(tag, contacts, { context: msg.mes });
            const anchor = getAnchorBundle(contact);
            const useFullAnchor = anchor.locked && anchor.sdPrompt && intent.level !== 'explicit';

            const built = buildPrompt({
                aiPrompt,
                characterAnchor: anchor.prompt,
                // SFW + locked → full SD prompt (max reference fidelity)
                // NSFW + locked → appearance-only anchor (avoid clothing/composition conflicts)
                characterFullPrompt: useFullAnchor ? anchor.sdPrompt : '',
                intent,
                model,
            });

            const { imageUrl } = await bridge.generate({
                model,
                positive: built.positive,
                negative: built.negative,
                width: built.width,
                height: built.height,
                steps: built.steps,
                cfg: built.cfg,
                sampler: built.sampler,
                scheduler: built.scheduler,
                seed: anchor.locked ? anchor.seed : null,
                denoise: 1.0,
            });

            // Replace tag with <img>
            const newImgTag = `<img src="${imageUrl}" class="smart-imgen-result" data-prompt="${escapeAttr(aiPrompt)}" data-intent="${intent.level}">`;
            msg.mes = msg.mes.replace(tag, newImgTag);
        } catch (err) {
            console.error(`[${EXT}] generation failed:`, err);
            toastr.error(`生图失败: ${err.message || err}`);
            // Replace with error placeholder so the broken tag doesn't keep retrying
            msg.mes = msg.mes.replace(tag, `<span class="smart-imgen-error">[生图失败: ${escapeAttr(err.message || String(err))}]</span>`);
        }
    }

    updateMessageBlock(idx, msg);
    eventSource.emit(event_types.MESSAGE_UPDATED, idx);
    await ctx.saveChat();
}

function findLastUserMessage(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user) return chat[i];
    }
    return null;
}

function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ────────────────────────────────────────────────────────────────────
// Public API for smart-phone
// ────────────────────────────────────────────────────────────────────

window.smartImageGen = {
    /** Called by smart-phone for in-bubble image slots */
    async generateFromPicTag(picTag, { contacts = [], hint = {} } = {}) {
        const m = picTag.match(/<pic[^>]*\sprompt="([^"]*)"/);
        if (!m) throw new Error('Invalid pic tag');
        const aiPrompt = m[1];

        const ctx = getContext();
        const userText = findLastUserMessage(ctx.chat)?.mes || '';
        const intent = classifyMessage(userText);

        const contact = resolveContact(picTag, contacts, hint);
        const anchor = getAnchorBundle(contact);

        const model = window.smartPhone?.getCurrentModel?.() || extension_settings[EXT].fallbackModel;
        const baseUrl = window.smartPhone?.getComfyuiUrl?.() || extension_settings[EXT].comfyuiUrl;
        const bridge = new ComfyUIBridge({ baseUrl });

        const useFullAnchor = anchor.locked && anchor.sdPrompt && intent.level !== 'explicit';
        const built = buildPrompt({
            aiPrompt,
            characterAnchor: anchor.prompt,
            // SFW locked → full SD prompt; NSFW locked → appearance only
            characterFullPrompt: useFullAnchor ? anchor.sdPrompt : '',
            intent,
            model,
        });

        const { imageUrl } = await bridge.generate({
            model,
            positive: built.positive,
            negative: built.negative,
            width: built.width,
            height: built.height,
            steps: built.steps,
            cfg: built.cfg,
            sampler: built.sampler,
            scheduler: built.scheduler,
            seed: anchor.locked ? anchor.seed : null,
            denoise: 1.0,
        });
        return imageUrl;
    },

    /** Called by smart-phone settings to make a per-character reference image */
    async generateReferenceImage({ characterName, anchorPrompt, anchorSdPrompt = '', existingSeed = null }) {
        const model = window.smartPhone?.getCurrentModel?.() || extension_settings[EXT].fallbackModel;
        const baseUrl = window.smartPhone?.getComfyuiUrl?.() || extension_settings[EXT].comfyuiUrl;
        const bridge = new ComfyUIBridge({ baseUrl });

        // If a full SD prompt was generated by ✨ AI, use it directly (skip prefix assembly)
        // Otherwise fall back to building from appearance tags
        const built = anchorSdPrompt
            ? buildReferencePromptFull({ sdPrompt: anchorSdPrompt, model })
            : buildReferencePrompt({ characterAnchor: anchorPrompt, model });

        const { imageUrl, seed } = await bridge.generate({
            model,
            positive: built.positive,
            negative: built.negative,
            width: built.width,
            height: built.height,
            steps: built.steps,
            cfg: built.cfg,
            sampler: built.sampler,
            scheduler: built.scheduler,
            seed: existingSeed,
            denoise: 1.0,
        });
        return { imageUrl, seed };
    },

    classifyIntent: classifyMessage,
};
