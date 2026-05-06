// XHS stranger-comment generation via separate phone API.
// Ported from mochi-phone's generateXHSStrangerComments.

import { callPhoneApi } from './phone-api.js';
import { findXhsPost, appendXhs, getChatState, save as saveState } from './state.js';

export async function generateStrangerComments(chatId, postId, ctx) {
    const post = findXhsPost(chatId, postId);
    if (!post || post.from !== 'user') return false;

    const charName = ctx?.name2 || ctx?.name || 'TA';
    const charLast = charName.split(/\s+/).pop() || charName;
    const userName = ctx?.name1 || '楼主';

    let charPersonaSnippet = '';
    try {
        const charObj = (ctx?.characters && ctx?.characterId !== undefined)
            ? ctx.characters[ctx.characterId] : (ctx?.char || null);
        if (charObj) {
            const parts = [];
            if (charObj.description) parts.push(charObj.description.replace(/\s+/g, ' ').trim().slice(0, 300));
            if (charObj.scenario) parts.push(charObj.scenario.replace(/\s+/g, ' ').trim().slice(0, 200));
            charPersonaSnippet = parts.filter(Boolean).join(' ');
        }
    } catch {}

    const recentChat = (ctx?.chat || []).slice(-15).map((m) => {
        const spk = m.is_user ? userName : (m.name || charName);
        return spk + ': ' + (m.mes || '').replace(/<[^>]+>/g, '').trim().slice(0, 120);
    }).join('\n');

    const relationCtx = [
        charPersonaSnippet ? `【角色背景】${charPersonaSnippet}` : '',
        recentChat ? `【近期对话片段】\n${recentChat}` : '',
    ].filter(Boolean).join('\n');

    const sysMsg = `你是一个小红书评论模拟器。以下帖子是由用户${userName}本人发的，模拟5位性格各异的陌生网友评论。

人物关系说明（严格遵守，不能混淆）：
- 帖子里的"我"表示发帖人${userName}自己
- ${charName}（姓${charLast}）是帖子中涉及到的另一个人物，不是发帖人
- 请根据下方【角色背景】和【近期对话片段】判断帖子中出现的亲属/关系称谓究竟对应谁

${relationCtx ? relationCtx + '\n' : ''}
评论要求：
- 每条评论必须紧扣帖子实际内容
- 评论有实质内容，不只是"坐等后续"空话

性格类型（各一条）：
1. 吃瓜补料型：结合帖子内容补充信息或目击经历
2. 担心共情型：针对帖子情境表达具体担忧
3. 阴阳怪气型：用正常语气阴阳，有具体所指
4. 无脑力挺型：支持${userName}立场，情绪化但有观点
5. 猜测爆瓜型：点出${charName}名字，八卦语气

每条15-30字，口语化，带emoji昵称。
**只返回 JSON 数组**：[{"user":"昵称","text":"评论内容"}]`;

    const prompt = `帖子标题：${post.title}\n帖子内容：${post.body}`;
    const resp = await callPhoneApi(prompt, sysMsg, { temperature: 0.95 });
    if (!resp) return false;

    let items = [];
    try {
        const match = resp.match(/\[[\s\S]*\]/);
        if (match) items = JSON.parse(match[0]);
    } catch (e) {
        console.warn('[smart-phone xhs] JSON parse failed:', e);
        return false;
    }
    if (!Array.isArray(items) || items.length === 0) return false;

    post.comments = post.comments || [];
    items.forEach((item, i) => {
        if (!item.user || !item.text) return;
        const ts = nowHHMM();
        post.comments.push({
            from: 'stranger_' + i,
            user: String(item.user).slice(0, 30),
            text: String(item.text).slice(0, 200),
            time: ts,
            replyTo: null,
        });
    });
    saveState();
    return true;
}

// Generate fresh stranger XHS posts (when no user post — refresh the feed)
export async function generateFreshFeed(chatId, ctx, worldContextText = '') {
    const charName = ctx?.name2 || ctx?.name || 'TA';
    const userName = ctx?.name1 || '用户';

    const worldSection = worldContextText
        ? `## 世界观设定（严格参照，所有帖子必须贴合此世界观）\n${worldContextText}\n\n`
        : '';

    const sysMsg = `${worldSection}你是一个小红书内容生成器。生成3条**陌生人/路人**视角的随机帖子。
每条要求：
- title 标题 8-15字
- body 正文 40-60字，口语化、有具体细节
- tag 从 [日常/穿搭/美食/旅行/情感/吐槽/八卦] 选一个
- pic 英文 booru tag 描述帖子主配图场景（8-15个tag，逗号分隔），例：1girl, casual outfit, park, sunny day, looking at viewer
- likes 一个 100-9999 的数字
- comments 至少 3 条评论，每条 {user,text}，带emoji昵称

**只返回 JSON 数组**：[{"user":"作者emoji昵称","tag":"标签","title":"标题","body":"正文","pic":"english booru tags","likes":数字,"comments":[{"user":"昵称","text":"评论"}]}]`;

    const prompt = `生成3条小红书随机帖子，话题各不相同。`;
    const resp = await callPhoneApi(prompt, sysMsg, { temperature: 0.95 });
    if (!resp) return [];

    let items = [];
    try {
        const match = resp.match(/\[[\s\S]*\]/);
        if (match) items = JSON.parse(match[0]);
    } catch (e) {
        console.warn('[smart-phone xhs] feed JSON parse failed:', e);
        return [];
    }
    if (!Array.isArray(items)) return [];

    const now = new Date();
    const dateStr = `${now.getMonth() + 1}-${now.getDate()}`;
    const posts = items.filter((it) => it && it.body).map((it, i) => ({
        id: `xhs_npc_${Date.now()}_${i}`,
        from: 'stranger',
        user: String(it.user || `网友${i}`).slice(0, 30),
        title: String(it.title || it.body.slice(0, 20)).slice(0, 80),
        body: String(it.body).slice(0, 600),
        tag: String(it.tag || '日常'),
        pic: it.pic ? `<pic prompt="${String(it.pic).replace(/"/g, "'").slice(0, 300)}"/>` : null,
        likes: Math.max(0, Math.min(99999, parseInt(it.likes, 10) || Math.floor(Math.random() * 5000 + 100))),
        likedByUser: false,
        comments: Array.isArray(it.comments) ? it.comments.slice(0, 8).map((c, j) => ({
            from: 'stranger_' + j,
            user: String(c.user || '匿名').slice(0, 30),
            text: String(c.text || '').slice(0, 200),
            time: nowHHMM(),
            replyTo: null,
        })) : [],
        time: nowHHMM(),
        date: dateStr,
    }));

    if (posts.length) appendXhs(chatId, posts);
    return posts;
}

function nowHHMM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
