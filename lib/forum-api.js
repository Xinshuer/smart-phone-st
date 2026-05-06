// 论坛 (贴吧) AI 内容生成 — 帖子 & 回复
import { callPhoneApi } from './phone-api.js';
import { appendForum, appendForumReplies } from './state.js';

function nowHHMM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export async function generateFreshPosts(chatId, ctx, worldContextText = '') {
    const worldSection = worldContextText
        ? `## 世界观设定（严格参照，所有帖子必须贴合此世界观）\n${worldContextText}\n\n`
        : '';

    const sysMsg = `${worldSection}你是百度贴吧内容生成器。生成6条路人视角的随机帖子，话题各不相同。
每条要求：
- board 从 [情感吧/搞笑吧/八卦吧/美食吧/旅游吧/日常吧/吐槽吧/游戏吧] 选一个
- author 带数字或emoji的昵称
- title 10-20字，有吸引力
- content 正文50-80字，口语化有具体细节
- pic 英文 booru tags 描述帖子主图场景（8-12个tag，逗号分隔），例：1girl, casual outfit, park, sunny day
- likes 10-9999 之间的整数
- replies 至少3条，每条 {author, content}，内容紧扣帖子，带emoji昵称

**只返回 JSON 数组**：[{"board":"","author":"","title":"","content":"","pic":"英文tags","likes":数字,"replies":[{"author":"","content":""}]}]`;

    const prompt = `生成6条百度贴吧随机帖子，话题各不相同。`;
    const resp = await callPhoneApi(prompt, sysMsg, { temperature: 0.95 });
    if (!resp) return [];

    let items = [];
    try {
        const match = resp.match(/\[[\s\S]*\]/);
        if (match) items = JSON.parse(match[0]);
    } catch (e) {
        console.warn('[smart-phone forum] JSON parse failed:', e);
        return [];
    }
    if (!Array.isArray(items)) return [];

    const now = new Date();
    const dateStr = `${now.getMonth() + 1}-${now.getDate()}`;
    const posts = items.filter((it) => it && it.title && it.content).map((it, i) => ({
        id: `tb_npc_${Date.now()}_${i}`,
        from: 'stranger',
        board: String(it.board || '日常吧'),
        author: String(it.author || `网友${i}`).slice(0, 30),
        title: String(it.title).slice(0, 60),
        content: String(it.content).slice(0, 600),
        pic: it.pic ? `<pic prompt="${String(it.pic).replace(/"/g, "'").slice(0, 300)}"/>` : null,
        likes: Math.max(0, Math.min(99999, parseInt(it.likes, 10) || Math.floor(Math.random() * 5000 + 10))),
        replies: Array.isArray(it.replies) ? it.replies.slice(0, 10).map((r, j) => ({
            from: 'stranger_' + j,
            author: String(r.author || '匿名').slice(0, 30),
            content: String(r.content || '').slice(0, 200),
            time: nowHHMM(),
        })) : [],
        time: nowHHMM(),
        date: dateStr,
    }));

    if (posts.length) appendForum(chatId, posts);
    return posts;
}

export async function generatePostReplies(chatId, postId, post, ctx) {
    if (!post) return false;
    const userName = ctx?.name1 || '楼主';

    const sysMsg = `你是百度贴吧回复模拟器。以下帖子是由用户${userName}发的，模拟5位性格各异的网友回复。
回复要求：
- 每条紧扣帖子内容，有实质内容
- 口语化，带emoji昵称
- 性格各异：力挺型、质疑型、补充信息型、歪楼开玩笑型、共情型各一条
- 每条20-40字

**只返回 JSON 数组**：[{"author":"带emoji昵称","content":"回复内容"}]`;

    const prompt = `帖子标题：${post.title}\n帖子内容：${post.content}`;
    const resp = await callPhoneApi(prompt, sysMsg, { temperature: 0.95 });
    if (!resp) return false;

    let items = [];
    try {
        const match = resp.match(/\[[\s\S]*\]/);
        if (match) items = JSON.parse(match[0]);
    } catch (e) {
        console.warn('[smart-phone forum] reply parse failed:', e);
        return false;
    }
    if (!Array.isArray(items) || items.length === 0) return false;

    const replies = items.filter((r) => r.author && r.content).map((r, i) => ({
        from: 'stranger_' + i,
        author: String(r.author).slice(0, 30),
        content: String(r.content).slice(0, 200),
        time: nowHHMM(),
    }));

    if (replies.length) appendForumReplies(chatId, postId, replies);
    return true;
}
