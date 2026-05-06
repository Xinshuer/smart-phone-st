// Worldbook integration: list entries from currently active world info,
// auto-classify entries as character vs lore, and import as contacts.
//
// Active sources (combined):
//   1. selected_world_info — globally enabled world books (array of names)
//   2. chat_metadata['world_info'] — chat-bound world book (single name)
//   3. character book — character.data.extensions.world (single name)

import { loadWorldInfo, selected_world_info, METADATA_KEY } from '../../../../world-info.js';
import { chat_metadata, characters, this_chid } from '../../../../../script.js';

// Heuristic classifier. Returns 'character' | 'lore'.
export function classifyEntry(entry) {
    const comment = (entry.comment || '').trim();
    const content = (entry.content || '').trim();
    const text = (comment + '\n' + content).slice(0, 1500);

    let charScore = 0;
    let loreScore = 0;

    // Comment looks like a name (2-6 chars CJK or 2-15 latin)
    if (/^[一-龥]{2,6}$|^[A-Za-z][A-Za-z\s]{1,15}$/.test(comment)) charScore += 3;

    // Content character markers
    const charMarkers = /姓名[：:]|名字[：:]|年龄[：:]|身高[：:]|体重[：:]|外貌|发色|发型|瞳色|眼睛|肤色|身材|性格|身份|职业|喜好|讨厌|兴趣|爱好|生日|血型|MBTI|cup|罩杯|三围|住址|出生地|学历/g;
    charScore += (text.match(charMarkers) || []).length;

    // Lore markers
    const loreMarkers = /世界观|背景设定|历史|文明|宗门|组织|帝国|王国|经济|政治|法则|秘境|地图|地理|时间线|战争|科技|魔法体系|境界|阵营|种族|流派/g;
    loreScore += (text.match(loreMarkers) || []).length * 2;

    // Length signal
    if (content.length > 2500) loreScore += 3;
    if (content.length < 600) charScore += 1;

    // First-person/second-person
    if (/^[他她你]/m.test(content) || content.includes('{{user}}')) charScore += 2;
    if (content.includes('{{char}}')) charScore += 1;

    return charScore >= loreScore ? 'character' : 'lore';
}

export function entryToContact(entry) {
    const name = guessName(entry);
    const content = entry.content || '';

    return {
        name,
        worldbookUid: entry.uid,
        bookName: entry._bookName || '',
        note: extractFirstLine(content, 40),
        anchor: {
            prompt: extractAppearancePrompt(content),
            seed: null,
            locked: false,
            referenceImage: null,
        },
        rawContent: content,
    };
}

function guessName(entry) {
    const c = (entry.comment || '').trim();
    if (c && c.length <= 12) return c;
    const m = (entry.content || '').match(/(?:姓名|名字)[：:]\s*(\S+)/);
    if (m) return m[1];
    return c.slice(0, 10) || '未命名';
}

function extractFirstLine(text, maxLen = 40) {
    const line = (text.split('\n').find((l) => l.trim()) || '').trim();
    return line.length > maxLen ? line.slice(0, maxLen) + '…' : line;
}

const TRANSLATE = {
    '黑发': 'black hair',
    '黑色长发': 'long black hair',
    '长黑发': 'long black hair',
    '棕发': 'brown hair',
    '金发': 'blonde hair',
    '银发': 'silver hair',
    '白发': 'white hair',
    '红发': 'red hair',
    '粉发': 'pink hair',
    '蓝发': 'blue hair',
    '紫发': 'purple hair',
    '绿发': 'green hair',
    '长发': 'long hair',
    '短发': 'short hair',
    '中长发': 'medium hair',
    '直发': 'straight hair',
    '卷发': 'wavy hair',
    '马尾': 'ponytail',
    '双马尾': 'twintails',
    '丸子头': 'hair bun',
    '黑瞳': 'black eyes',
    '棕瞳': 'brown eyes',
    '蓝瞳': 'blue eyes',
    '绿瞳': 'green eyes',
    '红瞳': 'red eyes',
    '紫瞳': 'purple eyes',
    '金瞳': 'golden eyes',
    '黑眼': 'black eyes',
    '棕眼': 'brown eyes',
    '蓝眼': 'blue eyes',
    '绿眼': 'green eyes',
    '白皙': 'fair skin',
    '雪白': 'pale skin',
    '小麦色': 'tan skin',
    '健康肤色': 'healthy skin',
    '亚洲': 'asian',
    '欧美': 'caucasian',
    '混血': 'mixed race',
    '巨乳': 'large breasts',
    '丰满': 'large breasts',
    '丰乳': 'large breasts',
    '中胸': 'medium breasts',
    '贫乳': 'small breasts',
    '细腰': 'narrow waist',
    '翘臀': 'curvy',
    '高挑': 'tall',
    '娇小': 'petite',
    '苗条': 'slim',
};

export function extractAppearancePrompt(content) {
    if (!content) return '';
    const tags = new Set();
    for (const [zh, en] of Object.entries(TRANSLATE)) {
        if (content.includes(zh)) tags.add(en);
    }
    return [...tags].join(', ');
}

// Get all worldbook entries currently active.
export async function getActiveWorldbookEntries() {
    const names = new Set();

    try {
        if (Array.isArray(selected_world_info)) {
            for (const n of selected_world_info) names.add(n);
        }
    } catch (err) { console.warn('[smart-phone] selected_world_info unavailable', err); }

    try {
        if (chat_metadata && chat_metadata[METADATA_KEY]) {
            names.add(chat_metadata[METADATA_KEY]);
        }
    } catch (err) { console.warn('[smart-phone] chat_metadata WB unavailable', err); }

    try {
        if (typeof this_chid !== 'undefined' && characters && characters[this_chid]) {
            const char = characters[this_chid];
            const charBookName = char?.data?.extensions?.world;
            if (charBookName) names.add(charBookName);
        }
    } catch (err) { console.warn('[smart-phone] character book unavailable', err); }

    if (names.size === 0) {
        console.log('[smart-phone] no active world books detected');
        return [];
    }

    console.log('[smart-phone] active world books:', [...names]);

    const all = [];
    for (const name of names) {
        try {
            const data = await loadWorldInfo(name);
            if (data?.entries) {
                for (const e of Object.values(data.entries)) {
                    if (e.disable) continue;
                    all.push({ ...e, _bookName: name });
                }
            }
        } catch (err) {
            console.warn(`[smart-phone] loadWorldInfo("${name}") failed:`, err);
        }
    }
    return all;
}

export async function listClassifiedEntries() {
    const entries = await getActiveWorldbookEntries();
    return entries.map((e) => ({
        uid: e.uid,
        bookName: e._bookName || '',
        comment: e.comment || '',
        content: (e.content || '').slice(0, 200),
        type: classifyEntry(e),
        raw: e,
    }));
}

export async function getEntryByUidInBook(uid, bookName) {
    if (!bookName) return null;
    try {
        const data = await loadWorldInfo(bookName);
        return Object.values(data?.entries || {}).find((e) => e.uid === uid) || null;
    } catch {
        return null;
    }
}

// Fetch and format full content for a list of world-context entries.
// Returns a string ready for injection into AI system prompts.
export async function fetchWorldContextText(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const parts = [];
    for (const e of entries) {
        const raw = await getEntryByUidInBook(e.uid, e.bookName);
        if (raw?.content) {
            const label = e.name || raw.comment || `entry-${e.uid}`;
            parts.push(`【${label}】\n${raw.content.trim()}`);
        }
    }
    return parts.join('\n\n');
}
