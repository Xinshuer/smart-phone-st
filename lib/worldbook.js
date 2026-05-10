// Worldbook integration: list entries from currently active world info,
// auto-classify entries as character vs lore, and import as contacts.
//
// Active sources (combined):
//   1. selected_world_info — globally enabled world books (array of names)
//   2. chat_metadata['world_info'] — chat-bound world book (single name)
//   3. character book — character.data.extensions.world (single name)

import { loadWorldInfo, selected_world_info, METADATA_KEY } from '../../../../world-info.js';
import { chat_metadata, characters, this_chid } from '../../../../../script.js';

// Tiered classifier — strong-signal first, density fallback last. Returns 'character' | 'lore'.
//
// Tier 1: Title meta-words (immediate decision)
// Tier 2: Persona-fingerprint structure (≥5 field lines + core persona field)
// Tier 3: Multi-name roster (5+ distinct CJK names → lore; not a single character)
// Tier 4: Density-normalized markers (per 1000 chars)
// Tier 5: Length / heuristic bias

const LORE_TITLE_META = /规则|设定|体系|法则|表现|反应|约定|互动|系统|数据库|机制|范例|速查表|背景|世界|时间线|历史|大纲|流程|模板|关系网|事件库|总览|手册|指南|配置|蓝图|约束|约法|档案库|图谱|结构|框架|协议|约定俗成|行为准则|描写规则|输出格式|文风|语气/;
const NAME_LIKE_TITLE = /^[一-龥]{2,5}$|^[A-Za-z][A-Za-z\s'\-]{1,15}$/;

const CORE_PERSONA_FIELDS = /(?:^|[\s|｜·【「『])(?:姓名|名字|本名|年龄|岁数|性别|身高|体重|发色|瞳色|眼睛|身材|罩杯|cup|三围|MBTI|血型|生日|来历|出生地|出身)\s*[:：=]/i;
const FIELD_LINE = /^[\s|｜·>]*[一-龥A-Za-z]{1,12}\s*[:：=]\s*\S/gm;

const CHAR_MARKERS = /姓名|名字|年龄|身高|体重|外貌|发色|发型|瞳色|眼睛|肤色|身材|性格|喜好|讨厌|兴趣|爱好|生日|血型|MBTI|cup|罩杯|三围|住址|出生地|学历/g;
const LORE_MARKERS = /世界观|背景设定|历史|文明|宗门|组织|帝国|王国|经济|政治|法则|秘境|地图|地理|时间线|战争|科技|魔法体系|境界|阵营|种族|流派|规则|系统|功法|修炼|灵气|法力|内力|货币|城市|地区|门派|势力|地形|气候|节日|禁忌|信仰|神灵|阵法|符文|炼器|炼丹|宗教|协议|约束|条款|事件|流程|约定俗成/g;

function countDistinctNames(content) {
    const candidates = content.match(/(?:^|[\s,，、|｜·【「『])([一-龥]{2,4})(?=[\s,，、|｜·：:】」』])/g) || [];
    const set = new Set(candidates.map((s) => s.replace(/[\s,，、|｜·【「『：:】」』]/g, '')));
    return set.size;
}

export function classifyEntry(entry) {
    const comment = (entry.comment || '').trim();
    const content = (entry.content || '').trim();

    // ── Tier 1: Title meta-words (highest priority — short-circuit) ──
    if (LORE_TITLE_META.test(comment)) return 'lore';
    if (NAME_LIKE_TITLE.test(comment)) return 'character';

    // ── Tier 2: Persona-fingerprint structure ──
    const fieldLineCount = (content.match(FIELD_LINE) || []).length;
    const hasCorePersonaField = CORE_PERSONA_FIELDS.test(content);
    if (fieldLineCount >= 5 && hasCorePersonaField) return 'character';

    // ── Tier 3: Multi-name roster → lore (5+ distinct names + no single-character core fields) ──
    const distinctNames = countDistinctNames(content);
    if (distinctNames >= 5 && !hasCorePersonaField) return 'lore';

    // ── Tier 4: Density (per 1000 chars, normalized) ──
    const text = (comment + '\n' + content).slice(0, 4000);
    const lenK = Math.max(1, content.length / 1000);
    const charDensity = (text.match(CHAR_MARKERS) || []).length / lenK;
    const loreDensity = (text.match(LORE_MARKERS) || []).length / lenK;

    // ── Tier 5: Bias terms ──
    let bias = 0;
    if (content.length > 2500) bias += 1.5;     // long doc → lore lean
    if (content.length < 600) bias -= 1.0;       // very short → char lean
    if (hasCorePersonaField) bias -= 1.5;        // even one persona-style field → char hint
    if (distinctNames >= 3) bias += 0.5;         // 3-4 names → mild lore lean

    // Lore weight ×2 (lore-markers are more specific than char-markers)
    const finalScore = (loreDensity * 2) - charDensity + bias;
    return finalScore > 0 ? 'lore' : 'character';
}

export function entryToContact(entry) {
    const name = guessName(entry);
    const content = entry.content || '';
    const book = entry._bookName || '';

    return {
        name,
        worldbookUid: entry.uid,
        bookName: book,
        // sourceBook: array of worldbook names this contact is associated with.
        // Filtering in settings/contacts shows contacts whose sourceBook overlaps active books.
        // Cross-world sharing: append more book names via 📍 / 📥 actions in UI.
        sourceBook: book ? [book] : [],
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

// Returns the set of worldbook NAMES currently active (global + chat-bound + character-bound).
// Used by smart-phone settings to filter contacts by world.
export function getActiveBookNames() {
    const names = new Set();
    try {
        if (Array.isArray(selected_world_info)) {
            for (const n of selected_world_info) names.add(n);
        }
    } catch {}
    try {
        if (chat_metadata && chat_metadata[METADATA_KEY]) names.add(chat_metadata[METADATA_KEY]);
    } catch {}
    try {
        if (typeof this_chid !== 'undefined' && characters && characters[this_chid]) {
            const charBookName = characters[this_chid]?.data?.extensions?.world;
            if (charBookName) names.add(charBookName);
        }
    } catch {}
    return [...names];
}

export function guessName(entry) {
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
// v0.14.27 加 maxCharsPerEntry，避免 fallback 大 lore 条目把生成调用 token 撑爆。
export async function fetchWorldContextText(entries, { maxCharsPerEntry = 0 } = {}) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const parts = [];
    for (const e of entries) {
        const raw = await getEntryByUidInBook(e.uid, e.bookName);
        if (raw?.content) {
            const label = e.name || raw.comment || `entry-${e.uid}`;
            let content = raw.content.trim();
            if (maxCharsPerEntry > 0 && content.length > maxCharsPerEntry) {
                // 截到上限附近的段落/句子边界，避免硬切到 token 中间
                const cap = content.slice(0, maxCharsPerEntry);
                const cut = Math.max(cap.lastIndexOf('\n\n'), cap.lastIndexOf('。'), cap.lastIndexOf('\n'));
                content = (cut > maxCharsPerEntry * 0.5 ? cap.slice(0, cut + 1) : cap) + '…';
            }
            parts.push(`【${label}】\n${content}`);
        }
    }
    return parts.join('\n\n');
}

// v0.14.27 自动 fallback：用户手动勾选的世界观条目可能 stale（指向已切走的世界书）或为空，
// 这时按当前激活的世界书自动抽 lore 条目作世界观参考，保证朋友圈/论坛/小红书生成
// 跟着世界书切换走。
//
// 优先级：
//   1. 手动勾选条目里 bookName 在 active books 列表的 → 用之（用户意图最高优先级）
//   2. 否则：从 active books 里抽 classifyEntry='lore' 的条目，取前 N 条
//   3. 都没有 → 空数组（生成器会走"无世界观"路径）
export async function getEffectiveWorldContextEntries(manualEntries = [], { fallbackLimit = 6 } = {}) {
    const activeBooks = new Set(getActiveBookNames());

    // 过滤手动条目：仅保留属于当前激活世界书的条目，丢掉 stale 引用
    const validManual = (manualEntries || []).filter((e) => e && activeBooks.has(e.bookName));
    if (validManual.length > 0) return validManual;

    if (activeBooks.size === 0) return [];

    // Fallback: 从激活的世界书自动抽 lore 条目
    const allEntries = await getActiveWorldbookEntries();
    const loreEntries = [];
    for (const e of allEntries) {
        if (classifyEntry(e) !== 'lore') continue;
        loreEntries.push({
            uid: e.uid,
            bookName: e._bookName || '',
            name: e.comment || `entry-${e.uid}`,
        });
        if (loreEntries.length >= fallbackLimit) break;
    }
    return loreEntries;
}
