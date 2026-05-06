// Phone protocol — XML tag format (ported from mochi-phone).
//
// AI emits a `<PHONE>...</PHONE>` block embedded in the main reply.
// Tags inside the block:
//   <SMS FROM="角色名" TIME="HH:MM">内容</SMS>             — 私聊文字
//   <VOICE FROM="角色名" TIME="HH:MM" DURATION="0:08">内容</VOICE>  — 语音
//   <HONGBAO FROM="角色名" AMOUNT="88" NOTE="备注"/>       — 红包
//   <GMSG FROM="角色名" GROUP="群名" TIME="HH:MM">内容</GMSG> — 群聊
//   <MOMENTS FROM="角色名" TIME="HH:MM">内容</MOMENTS>     — 朋友圈
//   <COMMENT MOMENT_ID="x" FROM="角色名" REPLY_TO="x">内容</COMMENT>
//   <NOTIFY TYPE="x" TEXT="x"/>
//   <SYNC STAGE="2" PROGRESS="45" STATUS="..."/>
//
// We strip the entire <PHONE> block from the displayed message so the
// main chat only shows the regular prose (or nothing if the AI only
// produced phone content).

const PHONE_BLOCK_RE = /<PHONE>([\s\S]*?)<\/PHONE>/i;
const REQUEST_TAG_RE = /<Request:[^>]*>/gi;

export function extractPhoneBlock(text) {
    if (!text || typeof text !== 'string') return null;
    const m = text.match(PHONE_BLOCK_RE);
    return m ? m[1] : null;
}

export function stripPhoneBlock(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(PHONE_BLOCK_RE, '').replace(REQUEST_TAG_RE, '').trim();
}

// ─────────────────────────────────────────────────────────────────────────
// Tag attribute parser
// ─────────────────────────────────────────────────────────────────────────

function getTagAttrs(rawAttrs) {
    const attrs = {};
    const re = /(\w+)\s*=\s*"([^"]*)"/g;
    let m;
    while ((m = re.exec(rawAttrs)) !== null) {
        attrs[m[1].toUpperCase()] = m[2];
    }
    return attrs;
}

function cleanInner(text) {
    return String(text || '')
        .replace(/<pic\b[\s\S]*?\/>/gi, '')
        .replace(/<img\b[^>]*>/gi, '')
        .replace(/image###[\s\S]*?###/gi, '')
        .replace(/<[^>]+>/g, '')
        .trim();
}

// ─────────────────────────────────────────────────────────────────────────
// Extractors
// ─────────────────────────────────────────────────────────────────────────

export function extractSMS(block) {
    const out = [];
    if (!block) return out;
    const re = /<SMS\b([^>]*)>([\s\S]*?)<\/SMS>/gi;
    let m;
    while ((m = re.exec(block)) !== null) {
        const a = getTagAttrs(m[1]);
        const content = cleanInner(m[2]);
        if (!content) continue;
        out.push({
            from: (a.FROM || '').trim(),
            type: 'text',
            content,
            time: (a.TIME || '').trim(),
            me: false,
            pic: extractPicTag(m[2]),
        });
    }
    return out;
}

export function extractVoice(block) {
    const out = [];
    if (!block) return out;
    const re = /<VOICE\b([^>]*)>([\s\S]*?)<\/VOICE>/gi;
    let m;
    while ((m = re.exec(block)) !== null) {
        const a = getTagAttrs(m[1]);
        out.push({
            from: (a.FROM || '').trim(),
            type: 'voice',
            content: cleanInner(m[2]),
            duration: (a.DURATION || '').trim(),
            time: (a.TIME || '').trim(),
            me: false,
        });
    }
    return out;
}

export function extractHongbao(block) {
    const out = [];
    if (!block) return out;
    const re = /<HONGBAO\b([^>]*?)\/?\s*>/gi;
    let m;
    while ((m = re.exec(block)) !== null) {
        const a = getTagAttrs(m[1]);
        out.push({
            from: (a.FROM || '').trim(),
            type: 'hongbao',
            content: a.NOTE || '红包',
            amount: a.AMOUNT || '',
            time: (a.TIME || '').trim(),
            me: false,
        });
    }
    return out;
}

export function extractGroup(block) {
    const out = [];
    if (!block) return out;
    const gmsgRe = /<GMSG\b([^>]*)>([\s\S]*?)<\/GMSG>/gi;
    let m;
    while ((m = gmsgRe.exec(block)) !== null) {
        const a = getTagAttrs(m[1]);
        const content = cleanInner(m[2]);
        if (!content) continue;
        out.push({
            kind: 'gmsg',
            from: (a.FROM || '').trim(),
            group: (a.GROUP || '').trim(),
            type: 'text',
            content,
            time: (a.TIME || '').trim(),
            pic: extractPicTag(m[2]),
        });
    }
    return out;
}

export function extractMoments(block) {
    const out = [];
    if (!block) return out;
    const re = /<MOMENTS\b([^>]*)>([\s\S]*?)<\/MOMENTS>/gi;
    let m;
    while ((m = re.exec(block)) !== null) {
        const a = getTagAttrs(m[1]);
        const content = cleanInner(m[2]);
        if (!content) continue;
        out.push({
            id: `mom_${(a.FROM || '').trim()}_${(a.TIME || '').replace(':', '')}_${Math.random().toString(36).slice(2, 6)}`,
            from: (a.FROM || '').trim(),
            content,
            pic: extractPicTag(m[2]),
            time: (a.TIME || '').trim(),
            comments: [],
        });
    }
    return out;
}

export function extractComments(block) {
    const out = [];
    if (!block) return out;
    const re = /<COMMENT\b([^>]*)>([\s\S]*?)<\/COMMENT>/gi;
    let m;
    while ((m = re.exec(block)) !== null) {
        const a = getTagAttrs(m[1]);
        const content = cleanInner(m[2]);
        if (!content) continue;
        out.push({
            momentId: a.MOMENT_ID || a.MOMENTID || '',
            from: (a.FROM || '').trim(),
            replyTo: (a.REPLY_TO || a.REPLYTO || '').trim(),
            content,
            time: (a.TIME || '').trim(),
        });
    }
    return out;
}

function extractPicTag(text) {
    if (!text) return null;
    const m = text.match(/<pic\b[^>]*\sprompt="[^"]*"[^>]*\/?>/i);
    return m ? m[0] : null;
}

// One-shot: extract all tagged content from a phone block.
export function parsePhoneBlock(block) {
    if (!block) return null;
    return {
        sms: extractSMS(block),
        voice: extractVoice(block),
        hongbao: extractHongbao(block),
        group: extractGroup(block),
        moments: extractMoments(block),
        comments: extractComments(block),
    };
}

// Convenience: from full message text, extract block then parse.
export function parsePhoneFromMessage(messageText) {
    const block = extractPhoneBlock(messageText);
    if (!block) return null;
    return parsePhoneBlock(block);
}

// ─────────────────────────────────────────────────────────────────────────
// Prompt builder — injected into main chat context via CHAT_COMPLETION_PROMPT_READY
// (mochi-phone style: protocol lives in system prompt, AI weaves PHONE block into reply)
// ─────────────────────────────────────────────────────────────────────────

export function buildProtocolPrompt({ contacts = [], lore = [] } = {}) {
    const contactList = contacts.length
        ? contacts.map((c) => `- ${c.name}${c.note ? ` (${c.note})` : ''}`).join('\n')
        : '（暂无导入联系人）';

    const loreSection = lore.length
        ? `\n## 启用的世界观条目\n${lore.map((e) => `- ${e.name}`).join('\n')}\n`
        : '';

    return `# 手机 UI 协议（必读、强制）

本场景使用**手机 UI 单轨输出**模式。所有手机相关内容**只**通过 <PHONE> 块的标签输出，不写任何叙事 prose 或场景描写。

## 当前联系人
${contactList}
${loreSection}
## 两种输出模式

### A. 手机短信触发模式（用户消息含 \`<Request: 手机短信提示...>\`）
**必须**输出形如：
\`\`\`
<PHONE>
<SMS FROM="目标角色" TIME="HH:MM">第一条回复</SMS>
<SMS FROM="目标角色" TIME="HH:MM">第二条补充</SMS>
</PHONE>
\`\`\`

**铁律：**
- ❌ 禁止任何 <PHONE> 块之外的文字（包括 prose 描写、动作描写、心理描写、场景描写）
- ❌ 禁止只输出"\\*XX 拿起手机回复\\*"之类的旁白
- ❌ 禁止 SMS 内容只写"[图片]"、"[语音]"、"(发了张照片)" —— 必须用真实标签
- ✅ 只输出 \`<PHONE>...</PHONE>\` 块本身，块外一字不写
- ✅ 同一角色一个回合发 2-4 条 SMS（活人感：连发短句、追问、补充）
- ✅ FROM **严格使用联系人列表的原名**（禁止译名/昵称/简称）
- ✅ 内容必须是该角色自己说的话，不能复述用户刚发的话

### B. 普通剧情 RP 模式（用户消息无 <Request:> 标记）
- 正常输出剧情 prose
- **可选**在结尾附加 \`<PHONE><MOMENTS FROM="..." TIME="...">动态内容</MOMENTS></PHONE>\` 让角色发条朋友圈
- 不强制

## 图片标签 —— 严格执行（解决"发自拍只显示[图片]"的问题）

当用户/剧情涉及发图（自拍/拍照/分享照片/晒图/给我看/show me），**必须**在该条 SMS/MOMENTS 内嵌 \`<pic>\` 标签：

✅ 正确：
\`\`\`
<SMS FROM="方彤彤" TIME="14:32">刚拍的 <pic prompt="1girl, selfie, school uniform, sunny day, outdoor, looking at viewer, soft smile, casual"/></SMS>
\`\`\`

❌ 错误：
\`\`\`
<SMS FROM="方彤彤" TIME="14:32">[图片]</SMS>
<SMS FROM="方彤彤" TIME="14:32">(发了张自拍)</SMS>
<SMS FROM="方彤彤" TIME="14:32">看 ☞📷</SMS>
\`\`\`

**\`<pic prompt="..."/>\` 内规则：**
- prompt **必须用英文 booru 标签**（逗号分隔）
- 包含主体/构图/服装/表情/光线/场景：例 \`1girl, solo, selfie, looking at viewer, school uniform, casual, soft smile, daylight, school courtyard\`
- 长度 8-25 个 tag

## 完整标签清单
\`\`\`
<SMS FROM="角色名" TIME="HH:MM">文字 [可嵌入 <pic prompt="..."/>]</SMS>
<VOICE FROM="角色名" TIME="HH:MM" DURATION="0:08">语音文字</VOICE>
<HONGBAO FROM="角色名" AMOUNT="88" NOTE="备注"/>
<GMSG FROM="角色名" GROUP="群名" TIME="HH:MM">群消息</GMSG>
<MOMENTS FROM="角色名" TIME="HH:MM">朋友圈正文 [可嵌入 <pic prompt="..."/>]</MOMENTS>
<COMMENT MOMENT_ID="x" FROM="角色名" REPLY_TO="谁">评论</COMMENT>
\`\`\`

**绝对禁止：**
- 替 {{user}} 输出任何回复
- 在 <PHONE> 之外讨论手机内容
- 模式 A 下任何 prose
`;
}

// OOC instruction wrapper for user-initiated phone messages.
export function buildSendOOC({ targetName, time, userText = '', isGroup = false, groupName = '', memberNames = [] }) {
    const userLine = userText ? `用户发送的短信内容：「${userText}」` : '';
    const imageHint = /(自拍|拍张照|发张照|发照片|发图|看看你|让我看|给我看|镜子|秀一下|show)/i.test(userText)
        ? '\n\n用户索取图片：这条 SMS 必须含 <pic prompt="english tags"/> 标签（不要写"[图片]"占位）。'
        : '';

    if (isGroup) {
        const allowed = memberNames.length
            ? `所有 FROM 必须严格用：${memberNames.join(' / ')}。禁翻译/别名。`
            : '所有 FROM 严格用已有联系人原名，禁翻译/别名。';
        return `[模式 A 触发——手机群聊]\n群名：${groupName}\n时间：${time}\n${userLine}\n\n仅输出 <PHONE>...</PHONE> 块，至少一条 <GMSG FROM="角色名" GROUP="${groupName}" TIME="${time}">回复</GMSG>，块外一字不写。${allowed}${imageHint}`;
    }

    return `[模式 A 触发——手机短信]\n目标角色：${targetName}\n时间：${time}\n${userLine}\n\n**强制规则**：\n- 仅输出 <PHONE>...</PHONE> 块，块外一字不写（不要 prose、不要旁白）\n- 至少一条 <SMS FROM="${targetName}" TIME="${time}">回复</SMS>，建议 2-4 条连发\n- FROM 严格用 "${targetName}"，禁翻译/别名\n- 是 ${targetName} 自己的话，不要复述用户内容${imageHint}`;
}

// Sanitize OOC for embedding in <Request: ...> tag (mochi technique).
export function makeRequestSafe(raw) {
    let t = String(raw || '');
    t = t
        .replace(/\{\{user\}\}/gi, '用户')
        .replace(/[\[\]【】\{\}<>「」『』]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return t;
}

export function nowHHMM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
