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

    // v0.14.28 优先用【视觉档案】表（确定性 + 含原作角色锚），fallback 走简单中→英 tag 映射
    const profile = extractVisualProfile(content);
    const appearance = profile ? buildAppearanceFromProfile(profile).appearance : extractAppearancePrompt(content);

    return {
        name,
        worldbookUid: entry.uid,
        bookName: book,
        // sourceBook: array of worldbook names this contact is associated with.
        sourceBook: book ? [book] : [],
        // v0.14.28 sourceHash: hash(bookName + uid + content) — 用于 resync 时检测条目是否变更
        sourceHash: entryHash(book, entry.uid, content),
        note: extractFirstLine(content, 40),
        anchor: {
            prompt: appearance,
            seed: null,
            locked: false,
            referenceImage: null,
        },
        rawContent: content,
    };
}

// v0.14.28 稳定哈希（djb2）—— 短、确定性、纯 JS（不依赖 Web Crypto，避免 async 链式调用）。
// 输入是文本，碰撞率对几百条 worldbook entry 足够低（30+ bit 输出空间）。
export function entryHash(bookName, uid, content) {
    const str = `${bookName || ''}|${uid}|${content || ''}`;
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
}

// v0.14.28 从 entry content 解析【视觉档案】表（5 段式角色卡里的字段|描述|booru 三列表）
// 原在 index.js v0.12.0，移到这里以便 entryToContact 在 import 时就拿到 anchor.prompt
// 和 resync 时统一调用。返回 null = 未找到（fallback 到 extractAppearancePrompt）。
export function extractVisualProfile(content) {
    if (!content || typeof content !== 'string') return null;
    const m = content.match(/##\s*【视觉档案】[\s\S]*?【\/视觉档案】/);
    if (!m) return null;
    const profile = {};
    for (const line of m[0].split('\n')) {
        if (!line.trim().startsWith('|')) continue;
        if (line.includes('字段') && line.includes('booru')) continue;
        if (/^\|[\s\-:]+\|/.test(line)) continue;
        const cells = line.split('|').map(s => s.trim());
        if (cells.length < 4) continue;
        const field = cells[1];
        const booru = cells[3];
        if (!field || !booru || booru === '—') continue;
        profile[field] = booru;
    }
    return Object.keys(profile).length >= 5 ? profile : null;
}

// v0.14.28 把视觉档案 profile 拼成 SD prompt（{ appearance, full }）
// appearance 用于 contact.anchor.prompt；full 含 quality preamble 用于直出 SD prompt。
export function buildAppearanceFromProfile(profile) {
    const parts = [];
    const anchor = profile['角色锚 tag'];
    if (anchor && anchor !== '—' && !anchor.startsWith('(')) {
        parts.push(`(${anchor}:1.2)`);
    }
    const order = [
        '年龄类', '体型类', '种族', '皮肤', '脸型', '五官', '妆',
        '头发色', '头发长度', '头发造型', '头发装饰',
        '眼睛色', '眼睛形状', '眼睛细节',
        '胸', '腰', '臀', '大腿', '四肢',
        '服装大类',
    ];
    for (const f of order) {
        const v = profile[f];
        if (v && v !== '—') parts.push(v);
    }
    const appearance = parts.join(', ');
    const QUALITY = 'masterpiece, best quality, highres, absurdres, intricate details';
    return { appearance, full: `${QUALITY}, ${appearance}` };
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

// v0.14.28 联系人自动 resync：当世界书条目内容修改（用户重新导入卡 / 直接编辑 entry）后，
// 比对 sourceHash，若变更则刷新 note / rawContent / anchor.prompt（重新跑视觉档案解析）。
//
// **保留用户自定义字段**：anchor.referenceImage（用户上传的参考图）、anchor.locked（用户锁定）、
// anchor.seed（用户指定）—— 这些是用户意图，resync 不能动。
// 仅刷新从条目内容衍生的字段。
//
// **不删除**：条目消失的联系人保留（用户可能想留作群成员等），仅 stat 出来。
//
// 返回 { backfilled, updated, unchanged, missing, contacts }
//   - backfilled: number — 老数据首次填入 sourceHash（不动 anchor.prompt 避免覆盖用户手编内容）
//   - updated: number — sourceHash 已存在且发现变更并刷新的数量
//   - unchanged: number — hash 一致跳过的数量
//   - missing: number — 联系人 worldbookUid 在激活世界书里找不到（条目被删/重生成 uid）
//   - contacts: 修改后的 contacts 数组（**调用方负责持久化**）
export async function resyncContactsFromActiveBooks(contacts) {
    const activeBooks = new Set(getActiveBookNames());
    const stats = { backfilled: 0, updated: 0, unchanged: 0, missing: 0 };
    if (!Array.isArray(contacts) || contacts.length === 0 || activeBooks.size === 0) {
        return { ...stats, contacts };
    }

    // 预加载所有 active book 的 entries（按 bookName→uid 索引）
    const allEntries = await getActiveWorldbookEntries();
    const byBookUid = new Map();
    for (const e of allEntries) {
        byBookUid.set(`${e._bookName}|${e.uid}`, e);
    }

    for (const c of contacts) {
        // 跳过没有 worldbook 关联的联系人（手动添加的陌生人等）
        if (!c.bookName || c.worldbookUid === undefined || c.worldbookUid === null) continue;
        // 跳过 bookName 不在当前激活范围的联系人（其他世界书的存量）
        if (!activeBooks.has(c.bookName)) continue;

        const fresh = byBookUid.get(`${c.bookName}|${c.worldbookUid}`);
        if (!fresh) { stats.missing++; continue; }

        const freshContent = fresh.content || '';
        const freshHash = entryHash(c.bookName, c.worldbookUid, freshContent);

        // 老数据兼容：0.14.27 之前导入的联系人无 sourceHash 字段。首次仅 backfill，
        // 不动 anchor.prompt 避免覆盖用户手动编辑过的外貌 tags。后续 resync 才会真正同步。
        if (c.sourceHash === undefined) {
            c.sourceHash = freshHash;
            c.rawContent = freshContent;
            c.note = extractFirstLine(freshContent, 40);
            stats.backfilled++;
            continue;
        }

        if (freshHash === c.sourceHash) { stats.unchanged++; continue; }

        // 内容变更 — 刷新派生字段，保留用户自定义
        const profile = extractVisualProfile(freshContent);
        const newAppearance = profile
            ? buildAppearanceFromProfile(profile).appearance
            : extractAppearancePrompt(freshContent);

        c.rawContent = freshContent;
        c.note = extractFirstLine(freshContent, 40);
        c.sourceHash = freshHash;
        if (!c.anchor) c.anchor = { seed: null, locked: false, referenceImage: null };
        // 用户锁定外貌 → 不动 anchor.prompt
        // 新派生为空 → 不擦写老的（防止用户编辑后无识别 tag 把 prompt 清空，或简易 tag 映射降级
        // 覆盖原本来自视觉档案的丰富 prompt）
        if (!c.anchor.locked && newAppearance && newAppearance.trim().length > 0) {
            c.anchor.prompt = newAppearance;
        }
        // v0.14.86 卡内容变更时自动作废 sdPrompt + referenceImage（除非用户锁定）：
        //   - sdPrompt 由 user 点 ✨ 后 AI 生成，不在 entry content 解析范围内
        //   - 老逻辑：sourceHash 变 → 只刷新 prompt（短 booru）；sdPrompt + referenceImage 保留 →
        //     改卡 agent 改了 sdPrompt 后用户必须手动 ✨，工作流不闭环
        //   - 新逻辑：sourceHash 变 + !locked → 一并作废 sdPrompt + referenceImage，触发 plugin
        //     端 UI 显示"需重生 ✨"提示。下次 user 访问该联系人头像/出图时会自动跑或 toast 提醒
        if (!c.anchor.locked) {
            if (c.anchor.sdPrompt) {
                c.anchor.sdPrompt = null;
                c.anchor.sdPromptStale = true; // 标记需重生
            }
            if (c.anchor.referenceImage) {
                c.anchor.referenceImage = null;
            }
        }
        stats.updated++;
    }

    return { ...stats, contacts };
}
