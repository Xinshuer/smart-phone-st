// 朋友圈 AI 内容生成 — 联系人动态 & 评论
import { callPhoneApi } from './phone-api.js';
import { appendMoments, appendMomentsComment } from './state.js';
import { isLewdContent } from './util.js';

function nowHHMM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export async function generateContactMoments(chatId, contacts, ctx, worldContextText = '') {
    if (!contacts || contacts.length === 0) return [];

    const slice = contacts.slice(0, 6);
    const hasWorld = !!worldContextText;

    const worldSection = hasWorld
        ? `## 世界观设定\n以下是本次内容生成必须参照的世界观。所有动态必须发生在这个世界中，背景、人物、用语、事物都要与该世界一致。\n\n${worldContextText}\n\n`
        : '';

    const worldConstraint = hasWorld
        ? '\n**重要**：动态的背景、用语、事件必须与上方世界观保持一致，体现该世界的特色。'
        : '';

    const contactsDesc = slice.map((c) => {
        const parts = [`姓名：${c.name}`];
        if (c.note) parts.push(`备注：${c.note}`);
        if (c.anchor?.prompt) parts.push(`外貌tags（自拍/肖像pic必须使用）：${c.anchor.prompt.slice(0, 200)}`);
        return parts.join('，');
    }).join('\n');

    const sysMsg = `${worldSection}你是一个微信朋友圈内容生成器。根据以下联系人信息，为每位联系人生成1-2条朋友圈动态，内容符合其人物性格和生活状态。

联系人列表：
${contactsDesc}

每条动态要求：
- author 必须是上方联系人名字之一
- content 30-80字，口语化，符合该角色性格
- pic：英文 booru tags。**重要**：若该动态是角色本人的自拍/肖像/穿搭照，必须以该角色的「外貌tags」为基础，末尾可追加场景/光线/构图tag（5-8个）；若无外貌tags或动态是风景/美食/物品等非人像配图，自行编写合适tag；纯文字动态填 null
- location 地点名称（可选，填 null 表示不附加位置）
- likes 0-50之间的整数
${worldConstraint}
**只返回 JSON 数组**：[{"author":"","content":"","pic":null,"location":null,"likes":数字}]`;

    const prompt = hasWorld
        ? `根据上方世界观和联系人信息，生成朋友圈动态。`
        : `根据联系人信息生成朋友圈动态。`;

    const resp = await callPhoneApi(prompt, sysMsg, { temperature: 0.9 });
    if (!resp) return [];

    let items = [];
    try {
        const match = resp.match(/\[[\s\S]*\]/);
        if (match) items = JSON.parse(match[0]);
    } catch (e) {
        console.warn('[smart-phone moments] JSON parse failed:', e);
        return [];
    }
    if (!Array.isArray(items)) return [];

    const now = new Date();
    const dateStr = `${now.getMonth() + 1}-${now.getDate()}`;
    const validNames = new Set(slice.map((c) => c.name));

    const posts = items.filter((it) => it && it.content && validNames.has(it.author)).map((it, i) => ({
        id: `moment_npc_${Date.now()}_${i}`,
        from: String(it.author),
        authorName: String(it.author),
        content: String(it.content).slice(0, 500),
        pic: it.pic ? `<pic prompt="${String(it.pic).replace(/"/g, "'").slice(0, 300)}"/>` : null,
        location: it.location ? String(it.location).slice(0, 30) : null,
        likes: Math.max(0, Math.min(999, parseInt(it.likes, 10) || 0)),
        likedByUser: false,
        comments: [],
        time: nowHHMM(),
        date: dateStr,
    }));

    if (posts.length) appendMoments(chatId, posts);
    return posts;
}

export async function generateMomentReplies(chatId, postId, post, contacts, ctx) {
    if (!post || !contacts || contacts.length === 0) return false;

    const authorName = post.authorName || post.from || '';
    const candidates = contacts.filter((c) => c.name !== authorName);
    if (candidates.length === 0) return false;

    const names = candidates.map((c) => c.name).join('、');
    const isCommanded = !!post.commandedByUser;
    const userName = ctx?.name1 || '主人';
    const isUserPost = post.from === 'user';
    // Lewd path also for user-posted NSFW (炫耀 mode) and commanded posts
    const isLewd = isCommanded || isLewdContent(post.content || '');

    const sysMsg = isLewd
        ? `你是露骨微信朋友圈评论模拟器。这是一条**敏感/露骨动态**，从联系人中选 2-3 位发表评论。

动态归属：
${isCommanded
    ? `- 表面作者：${escapeAuthor(authorName)}（被她的"主人/老板"${userName}命令发出来）\n- 真正主导者：${userName}（"展示我的女人" 炫耀+羞辱）`
    : isUserPost
    ? `- 动态由 ${userName} 本人发布，炫耀动态里那个女人（推断为他的伴侣/战利品）的露骨内容`
    : `- 由 ${escapeAuthor(authorName)} 主动发布的露骨动态`}

联系人（按身份/关系差异化反应）：${names}

评论要求（**全部**好色猥琐 / 调戏 / 羞辱，**禁止** SFW 慰问、**禁止**关心）：
- 根据联系人**身份**和与作者/${userName}的**关系**差异化露骨：
  · 闺蜜/同辈女：嫉妒 + 暗酸 + 偷偷意淫
  · 男性下属/晚辈：跪舔崇拜 ${isCommanded || !isUserPost ? `${escapeAuthor(authorName)}` : userName} + 露骨意淫
  · 男性同辈/对手：调戏挑衅 / 嫉妒 ${userName}
  · 长辈/严肃身份：先 OOC（"成何体统！"）后偷偷舔屏 / 暗示自己也想
- 每条 15-30 字，口语化露骨
- 紧扣动态的露骨细节，不要泛泛羡慕

**只返回 JSON 数组**：[{"author":"联系人名字","content":"评论内容"}]`
        : `你是一个微信朋友圈评论模拟器。以下动态是由${escapeAuthor(authorName)}发布的，从以下联系人中选2-3位发表评论。
联系人：${names}

评论要求：
- 每条必须紧扣动态内容
- 口语化，自然，10-25字
- 性格各异

**只返回 JSON 数组**：[{"author":"联系人名字","content":"评论内容"}]`;

    const prompt = `动态内容：${post.content}`;
    const resp = await callPhoneApi(prompt, sysMsg, { temperature: 0.9 });
    if (!resp) return false;

    let items = [];
    try {
        const match = resp.match(/\[[\s\S]*\]/);
        if (match) items = JSON.parse(match[0]);
    } catch (e) {
        console.warn('[smart-phone moments] reply parse failed:', e);
        return false;
    }
    if (!Array.isArray(items) || items.length === 0) return false;

    const validNames = new Set(candidates.map((c) => c.name));
    const comments = items.filter((r) => r.author && r.content && validNames.has(r.author)).map((r) => ({
        from: String(r.author),
        authorName: String(r.author),
        content: String(r.content).slice(0, 200),
        time: nowHHMM(),
    }));

    if (comments.length) appendMomentsComment(chatId, postId, comments);
    return comments.length > 0;
}

function escapeAuthor(name) {
    return String(name || '').replace(/[<>"]/g, '');
}
