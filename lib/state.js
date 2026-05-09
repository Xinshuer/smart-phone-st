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

    // v0.14.0 群聊：成员用 contactId 而非 name 引用，避免重命名/同名 bug。
    // members[].nameSnapshot 仅作"已删成员历史显示"兜底，正常按 contactId 解析。
    groups: [], // [{ id:'grp_xxx', name, members:[{contactId, nameSnapshot}], sourceBook:[], note, createdAt, deletedAt? }]

    // Per-chat rolling state
    chats: {}, // {[chatId]: {threads: {[contactName]: msgs[]}, groupThreads: {[groupId]: msgs[]}, xhs:[], forum:[], moments:[]}}

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
    // v0.8.0 大瘦身：只剩 wai_anihentai (anime) + asian_realism (写实) 两个模型
    imageGen: {
        backend: 'comfyui', // comfyui | st-native | smart-image-gen
        comfyuiUrl: 'http://127.0.0.1:8188',
        comfyuiUrlMobile: '', // LAN IP for phone access; empty = fall back to comfyuiUrl
        currentModel: 'wai_anihentai', // wai_anihentai | asian_realism
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
    // v0.8.0 大瘦身：迁移用户可能保存的已删模型 → wai_anihentai
    const VALID_MODELS = ['wai_anihentai', 'asian_realism'];
    if (s.imageGen && !VALID_MODELS.includes(s.imageGen.currentModel)) {
        s.imageGen.currentModel = 'wai_anihentai';
    }
    return s;
}

export function save() {
    saveSettingsDebounced();
}

export function getChatState(chatId) {
    const s = load();
    if (!s.chats[chatId]) {
        s.chats[chatId] = { threads: {}, groupThreads: {}, xhs: [], forum: [], moments: [] };
    }
    // forward-compat: ensure all fields exist (for chats persisted before xhs/moments/groups fields added)
    const cs = s.chats[chatId];
    if (!cs.threads || typeof cs.threads !== 'object') cs.threads = {};
    if (!cs.groupThreads || typeof cs.groupThreads !== 'object') cs.groupThreads = {};
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

// ─────────────────────────────────────────────────────────────────────────
// v0.14.0 群聊数据层 — members 用 contactId 引用 + nameSnapshot 兜底
// ─────────────────────────────────────────────────────────────────────────

export function findContactById(contactId) {
    if (!contactId) return null;
    const s = load();
    return s.contacts.find((c) => c.id === contactId) || null;
}

export function findGroup(groupId) {
    if (!groupId) return null;
    const s = load();
    return (s.groups || []).find((g) => g.id === groupId) || null;
}

export function getActiveGroups() {
    const s = load();
    return (s.groups || []).filter((g) => !g.deletedAt);
}

// 创建群聊。强制 ≥2 个成员；name 必填（UI 层校验）。
export function createGroup({ name, memberContactIds, sourceBook = [], note = '' }) {
    if (!name || !Array.isArray(memberContactIds) || memberContactIds.length < 2) {
        throw new Error('群聊创建失败：群名必填，成员至少 2 人');
    }
    const s = load();
    const id = 'grp_' + Math.random().toString(36).slice(2, 10);
    // members 用 contactId 引用；nameSnapshot 仅作已删成员历史显示兜底
    const members = memberContactIds.map((cid) => {
        const c = s.contacts.find((x) => x.id === cid);
        return { contactId: cid, nameSnapshot: c?.name || '已删除成员' };
    });
    if (!Array.isArray(s.groups)) s.groups = [];
    s.groups.push({
        id, name, members, sourceBook, note,
        createdAt: Date.now(),
    });
    save();
    return id;
}

export function updateGroup(groupId, patch) {
    const s = load();
    const g = (s.groups || []).find((x) => x.id === groupId);
    if (!g) return false;
    Object.assign(g, patch);
    save();
    return true;
}

// 软删除：30 天后清理。立即删除时清掉 groupThreads。
export function softDeleteGroup(groupId) {
    const s = load();
    const g = (s.groups || []).find((x) => x.id === groupId);
    if (!g) return false;
    g.deletedAt = Date.now();
    save();
    return true;
}

export function restoreGroup(groupId) {
    const s = load();
    const g = (s.groups || []).find((x) => x.id === groupId);
    if (!g) return false;
    delete g.deletedAt;
    save();
    return true;
}

export function permanentlyDeleteGroup(groupId) {
    const s = load();
    s.groups = (s.groups || []).filter((g) => g.id !== groupId);
    // 同步清掉所有 chats 里关联的 groupThreads
    for (const chatId of Object.keys(s.chats || {})) {
        if (s.chats[chatId].groupThreads) delete s.chats[chatId].groupThreads[groupId];
    }
    save();
}

// 清理超过 30 天的软删群（启动时调用）
export function purgeExpiredDeletedGroups() {
    const s = load();
    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    const expired = (s.groups || []).filter((g) => g.deletedAt && (now - g.deletedAt) > THIRTY_DAYS);
    for (const g of expired) permanentlyDeleteGroup(g.id);
    return expired.length;
}

// 解析群成员：返回 [{contactId, nameSnapshot, contact, hasAnchor, isDeleted}]
// contact 为 null 时表示已删除（按 nameSnapshot 兜底显示，hasAnchor=false 不能合影）
export function resolveGroupMembers(group) {
    if (!group?.members) return [];
    const s = load();
    return group.members.map((m) => {
        const contact = s.contacts.find((c) => c.id === m.contactId) || null;
        return {
            contactId: m.contactId,
            nameSnapshot: contact?.name || m.nameSnapshot || '已删除成员',
            contact,
            hasAnchor: !!(contact?.anchor?.prompt),
            isDeleted: !contact,
        };
    });
}

// 群聊消息追加
export function appendGroupMessages(chatId, groupId, messages) {
    if (!Array.isArray(messages) || !messages.length) return;
    const cs = getChatState(chatId);
    if (!cs.groupThreads[groupId]) cs.groupThreads[groupId] = [];
    cs.groupThreads[groupId].push(...messages);
    save();
}

export function popLastGroupNpcBatch(chatId, groupId) {
    const cs = getChatState(chatId);
    const thread = cs.groupThreads?.[groupId];
    if (!thread?.length) return [];
    const removed = [];
    while (thread.length > 0 && !thread[thread.length - 1].me) {
        removed.unshift(thread.pop());
    }
    if (removed.length) save();
    return removed;
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
