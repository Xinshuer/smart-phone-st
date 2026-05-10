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
    // v0.10.1 新增 unholy_desire + diving_illustrious 两个 anime 模型
    // v0.14.19 新增 lustify_v8 (写实 NSFW 旗舰) + nova_asian_il (Illustrious 亚洲写实)
    const VALID_MODELS = ['wai_anihentai', 'asian_realism', 'unholy_desire', 'diving_illustrious', 'lustify_v8', 'nova_asian_il'];
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
        s.chats[chatId] = { threads: {}, groupThreads: {}, activeChats: [], strangerAnchors: {}, xhs: [], forum: [], moments: [] };
    }
    // forward-compat: ensure all fields exist (for chats persisted before xhs/moments/groups fields added)
    const cs = s.chats[chatId];
    if (!cs.threads || typeof cs.threads !== 'object') cs.threads = {};
    if (!cs.groupThreads || typeof cs.groupThreads !== 'object') cs.groupThreads = {};
    // v0.14.2 activeChats：用户主动开启的单聊列表（微信式行为）
    // 老数据迁移：首次见到没 activeChats 字段时，把所有非空 threads 自动加入
    if (!Array.isArray(cs.activeChats)) {
        cs.activeChats = Object.keys(cs.threads).filter(name => Array.isArray(cs.threads[name]) && cs.threads[name].length > 0);
    }
    // v0.14.8 strangerAnchors：剧情中出现的临时 NPC 视觉锚点池（chat-scoped）
    // key = NPC name, value = { kind, core, firstSeen, appearCount, picTagSource }
    if (!cs.strangerAnchors || typeof cs.strangerAnchors !== 'object') cs.strangerAnchors = {};
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

// ─────────────────────────────────────────────────────────────────────────
// v0.14.25 chat-state 孤儿清理 — 当用户从酒馆删除角色卡时，对应的 chats[chatId]
// 数据会留在 extension_settings 里。本组 API 让用户能看到所有存储的 chat state
// 并选择性清理（不主动删——避免误伤未当前打开的合法历史 chat）。
// ─────────────────────────────────────────────────────────────────────────
export function listAllChatStates() {
    const s = load();
    const chats = s.chats || {};
    const list = [];
    for (const [chatId, cs] of Object.entries(chats)) {
        const threadCount = Object.keys(cs.threads || {}).length;
        const groupThreadCount = Object.keys(cs.groupThreads || {}).length;
        const messageCount = Object.values(cs.threads || {}).reduce((a, msgs) => a + (msgs?.length || 0), 0);
        const groupMessageCount = Object.values(cs.groupThreads || {}).reduce((a, msgs) => a + (msgs?.length || 0), 0);
        const xhsCount = (cs.xhs || []).length;
        const forumCount = (cs.forum || []).length;
        const momentsCount = (cs.moments || []).length;
        const activeContacts = (cs.activeChats || []).length;
        const sizeBytes = JSON.stringify(cs).length;
        list.push({
            chatId,
            threadCount, groupThreadCount, messageCount, groupMessageCount,
            xhsCount, forumCount, momentsCount, activeContacts,
            sizeBytes,
        });
    }
    return list.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

export function purgeChatStates(chatIds) {
    const s = load();
    if (!s.chats) return 0;
    let removed = 0;
    for (const id of chatIds) {
        if (s.chats[id]) {
            delete s.chats[id];
            removed++;
        }
    }
    save();
    return removed;
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

// ─────────────────────────────────────────────────────────────────────────
// v0.14.2 activeChats helper — 微信式"主动开启聊天" 语义
// ─────────────────────────────────────────────────────────────────────────

// 把联系人加到聊天列表（重复加不重复）。返回是否新增。
export function activateChatThread(chatId, contactName) {
    if (!contactName) return false;
    const cs = getChatState(chatId);
    if (!cs.activeChats.includes(contactName)) {
        cs.activeChats.push(contactName);
        save();
        return true;
    }
    return false;
}

// 从聊天列表移除联系人 + 清空聊天历史（微信"删除该聊天"语义）。
// 联系人本身保留（在联系人 tab 仍可见，可重新开启聊天）。
export function deactivateChatThread(chatId, contactName) {
    if (!contactName) return false;
    const cs = getChatState(chatId);
    cs.activeChats = cs.activeChats.filter(n => n !== contactName);
    if (cs.threads[contactName]) delete cs.threads[contactName];
    save();
    return true;
}

export function isChatThreadActive(chatId, contactName) {
    const cs = getChatState(chatId);
    return cs.activeChats.includes(contactName);
}

// ─────────────────────────────────────────────────────────────────────────
// v0.14.8 陌生人锚点 — 临时 NPC 视觉一致性
// 设计原则：
//   - chat-scoped (cs.strangerAnchors) 不跨 chat 污染
//   - name 作为 key（AI 协议按 name 复用）
//   - 用户手动管理（无自动清理；用户决策 #2）
//   - 升级为联系人时 contact 加 tempOrigin: true 标记，自动生成 (xhs/forum/moments)
//     的 fresh feed 排除，防止临时 NPC 反复出现（用户决策约束）
// ─────────────────────────────────────────────────────────────────────────

export function getStrangerAnchor(chatId, name) {
    if (!name) return null;
    const cs = getChatState(chatId);
    return cs.strangerAnchors[name] || null;
}

export function saveStrangerAnchor(chatId, name, { kind, core, picTagSource = '' }) {
    if (!name || !core) return false;
    const cs = getChatState(chatId);
    if (cs.strangerAnchors[name]) {
        // 已存在则只增加 appearCount（不覆盖 core）
        cs.strangerAnchors[name].appearCount = (cs.strangerAnchors[name].appearCount || 1) + 1;
    } else {
        cs.strangerAnchors[name] = {
            kind: kind || 'fictional_female',
            core,
            firstSeen: Date.now(),
            appearCount: 1,
            picTagSource: (picTagSource || '').slice(0, 500),
        };
    }
    save();
    return true;
}

export function updateStrangerAnchor(chatId, name, patch) {
    const cs = getChatState(chatId);
    const s = cs.strangerAnchors[name];
    if (!s) return false;
    Object.assign(s, patch);
    save();
    return true;
}

export function removeStrangerAnchor(chatId, name) {
    const cs = getChatState(chatId);
    delete cs.strangerAnchors[name];
    save();
    return true;
}

export function incrementStrangerAppearCount(chatId, name) {
    const cs = getChatState(chatId);
    const s = cs.strangerAnchors[name];
    if (!s) return false;
    s.appearCount = (s.appearCount || 1) + 1;
    save();
    return true;
}

export function listStrangerAnchors(chatId) {
    const cs = getChatState(chatId);
    return Object.entries(cs.strangerAnchors || {})
        .map(([name, data]) => ({ name, ...data }))
        .sort((a, b) => (b.appearCount || 0) - (a.appearCount || 0)); // 按出现次数 DESC
}

// 升级陌生人为正式联系人。
// contact 加 tempOrigin: true 标记 → xhs/forum/moments 自动生成时排除（不主动让 ta 发帖）
// 仅当用户在聊天里主动 cue 该 NPC 时 AI 才会在 SMS/GMSG 里让 ta 出现
// 用户决策 #3：sourceBook 自动取当前激活世界书并集
export function promoteStrangerToContact(chatId, name, activeBookNames = []) {
    const cs = getChatState(chatId);
    const stranger = cs.strangerAnchors[name];
    if (!stranger) return false;
    const s = load();
    // 如果已有同名联系人，merge anchor 不重复创建
    const existing = s.contacts.find(c => c.name === name);
    if (existing) {
        // upsert：merge anchor.prompt
        if (!existing.anchor) existing.anchor = {};
        if (!existing.anchor.prompt) existing.anchor.prompt = stranger.core;
        existing.tempOrigin = true; // 标记仍是临时来源
    } else {
        s.contacts.push({
            id: 'c_' + Math.random().toString(36).slice(2, 10),
            name,
            note: `(从陌生人升级 · ${stranger.kind}) ${(stranger.picTagSource || '').slice(0, 60)}`,
            rawContent: '', // 没世界书 entry
            sourceBook: Array.isArray(activeBookNames) && activeBookNames.length ? [...activeBookNames] : [],
            tempOrigin: true, // 关键：标记为临时来源 → 自动生成 (xhs/forum/moments fresh feed) 排除
            originStranger: name,
            anchor: {
                prompt: stranger.core,
                sdPrompt: '',
                seed: null,
                locked: false,
            },
        });
    }
    delete cs.strangerAnchors[name];
    save();
    return true;
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
