// Persistent state for the phone, stored under extension_settings.smartPhone.
// Lives across chats; keyed by chat id where appropriate.

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';

const KEY = 'smartPhone';

export const defaults = {
    enabled: true,
    floatPosition: { x: null, y: null },
    minimized: false,
    activeApp: 'messages',

    // Per-character contacts (chat-scoped state lives in chats[chatId])
    contacts: [], // {id, name, avatar, note, anchor:{prompt,seed,locked}}

    // Per-chat rolling state
    chats: {}, // {[chatId]: {threads: {[contactName]: msgs[]}, xhs:[], forum:[], moments:[]}}

    // Worldbook settings
    worldbook: {
        importedEntries: [], // [{uid, name, type:'character'|'lore', enabled}]
        autoClassify: true,
    },

    // Lore entries injected as world-setting context into XHS / forum AI generation
    worldContext: [], // [{uid, bookName, name}]

    // Independent phone API (OpenAI-compatible). Used to generate phone YAML
    // separately from the main chat AI. mochi-phone style.
    api: {
        url: '',          // e.g. https://api.deepseek.com/v1
        key: '',          // Bearer token
        model: '',        // e.g. deepseek-chat
        triggerMode: 'auto', // 'auto' = call after every main AI reply; 'manual' = only on button press
        // When true, route ALL phone-side AI calls (XHS comments, forum replies, moments,
        // stranger feeds, etc.) through ST's main chat pipeline via generateQuietPrompt.
        // Benefit: the user's main preset (e.g. 夏瑾 with JailbreakPrompt) applies → NSFW
        // posts/comments work without DeepSeek refusing. Cost: uses main API quota.
        useMainPreset: false,
    },

    // Image generation
    imageGen: {
        backend: 'comfyui', // comfyui | st-native | smart-image-gen
        comfyuiUrl: 'http://127.0.0.1:8188',
        comfyuiUrlMobile: '', // LAN IP for phone access; empty = fall back to comfyuiUrl
        currentModel: 'pony', // pony | noobai | noobai_easyneg | noobai_miaomiao | majicmix | asian_realism
        workflowPaths: {
            pony: 'g:/本地部署/comfyUI生图工作流-pony-realism.txt',
            noobai: 'g:/本地部署/comfyUI生图工作流-noobai-vpred.txt',
            noobai_easyneg: 'g:/本地部署/comfyUI生图工作流-noobai-vpred-easyneg.txt',
            noobai_miaomiao: 'g:/本地部署/comfyUI生图工作流-noobai-vpred-miaomiao.txt',
            majicmix: 'g:/本地部署/comfyUI生图工作流-majicmix.txt',
            asian_realism: 'g:/本地部署/comfyUI生图工作流-asian-realism.txt',
        },
    },
};

export function load() {
    if (!extension_settings[KEY]) {
        extension_settings[KEY] = structuredClone(defaults);
    }
    const s = extension_settings[KEY];
    // Merge missing keys from defaults (forward-compat)
    for (const k of Object.keys(defaults)) {
        if (s[k] === undefined) s[k] = structuredClone(defaults[k]);
    }
    return s;
}

export function save() {
    saveSettingsDebounced();
}

export function getChatState(chatId) {
    const s = load();
    if (!s.chats[chatId]) {
        s.chats[chatId] = { threads: {}, xhs: [], forum: [], moments: [] };
    }
    // forward-compat: ensure all fields exist (for chats persisted before xhs/moments fields added)
    const cs = s.chats[chatId];
    if (!Array.isArray(cs.threads && cs.threads)) cs.threads = cs.threads || {};
    if (!Array.isArray(cs.xhs)) cs.xhs = [];
    if (!Array.isArray(cs.forum)) cs.forum = [];
    if (!Array.isArray(cs.moments)) cs.moments = [];
    return cs;
}

export function appendMessages(chatId, messages) {
    if (!Array.isArray(messages) || messages.length === 0) return;
    const cs = getChatState(chatId);
    for (const m of messages) {
        const thread = m.from || '未知';
        if (!cs.threads[thread]) cs.threads[thread] = [];
        cs.threads[thread].push(m);
    }
    save();
}

export function appendForum(chatId, posts) {
    if (!Array.isArray(posts) || posts.length === 0) return;
    const cs = getChatState(chatId);
    cs.forum.push(...posts);
    if (cs.forum.length > 200) cs.forum.splice(0, cs.forum.length - 200);
    save();
}

export function appendXhs(chatId, posts) {
    if (!Array.isArray(posts) || posts.length === 0) return;
    const cs = getChatState(chatId);
    cs.xhs.push(...posts);
    if (cs.xhs.length > 200) cs.xhs.splice(0, cs.xhs.length - 200);
    save();
}

export function appendMoments(chatId, items) {
    if (!Array.isArray(items) || items.length === 0) return;
    const cs = getChatState(chatId);
    cs.moments.push(...items);
    if (cs.moments.length > 200) cs.moments.splice(0, cs.moments.length - 200);
    save();
}

export function clearXhs(chatId) {
    const cs = getChatState(chatId);
    cs.xhs = [];
    save();
}

export function clearForum(chatId) {
    const cs = getChatState(chatId);
    cs.forum = [];
    save();
}

export function clearMoments(chatId) {
    const cs = getChatState(chatId);
    cs.moments = [];
    save();
}

export function findXhsPost(chatId, postId) {
    const cs = getChatState(chatId);
    return (cs.xhs || []).find((p) => p.id === postId);
}

export function findForumPost(chatId, postId) {
    const cs = getChatState(chatId);
    return (cs.forum || []).find((p) => p.id === postId);
}

export function appendForumReplies(chatId, postId, replies) {
    const cs = getChatState(chatId);
    const post = (cs.forum || []).find((p) => p.id === postId);
    if (!post) return;
    if (!Array.isArray(post.replies)) post.replies = [];
    post.replies.push(...replies);
    save();
}

export function findMomentsPost(chatId, postId) {
    const cs = getChatState(chatId);
    return (cs.moments || []).find((p) => p.id === postId);
}

export function appendMomentsComment(chatId, postId, comments) {
    const cs = getChatState(chatId);
    const post = (cs.moments || []).find((p) => p.id === postId);
    if (!post) return;
    if (!Array.isArray(post.comments)) post.comments = [];
    post.comments.push(...(Array.isArray(comments) ? comments : [comments]));
    save();
}

export function toggleMomentsLike(chatId, postId) {
    const cs = getChatState(chatId);
    const post = (cs.moments || []).find((p) => p.id === postId);
    if (!post) return false;
    post.likedByUser = !post.likedByUser;
    post.likes = Math.max(0, (post.likes || 0) + (post.likedByUser ? 1 : -1));
    save();
    return post.likedByUser;
}

export function findContact(name) {
    const s = load();
    return s.contacts.find((c) => c.name === name);
}

export function upsertContact(contact) {
    const s = load();
    const i = s.contacts.findIndex((c) => c.name === contact.name);
    if (i >= 0) Object.assign(s.contacts[i], contact);
    else s.contacts.push({ id: cryptoRandomId(), ...contact });
    save();
}

export function removeContact(name) {
    const s = load();
    s.contacts = s.contacts.filter((c) => c.name !== name);
    save();
}

function cryptoRandomId() {
    return 'c_' + Math.random().toString(36).slice(2, 10);
}

export function popLastNpcBatch(chatId, threadName) {
    const cs = getChatState(chatId);
    const thread = cs.threads[threadName];
    if (!thread?.length) return [];
    const removed = [];
    while (thread.length > 0 && !thread[thread.length - 1].me) {
        removed.unshift(thread.pop());
    }
    if (removed.length) save();
    return removed;
}

// World context entries for XHS / forum AI generation
export function getWorldContext() {
    return load().worldContext || [];
}

export function toggleWorldContext({ uid, bookName, name }) {
    const s = load();
    if (!Array.isArray(s.worldContext)) s.worldContext = [];
    const idx = s.worldContext.findIndex((e) => e.uid === uid && e.bookName === bookName);
    if (idx >= 0) {
        s.worldContext.splice(idx, 1);
    } else {
        s.worldContext.push({ uid, bookName, name });
    }
    save();
}
