// 论坛 (贴吧) AI 内容生成 — 帖子 & 回复
import { callPhoneApi } from './phone-api.js';
import { buildLewdCommenterSystemPrompt } from './lewd-commenter.js';
import { appendForum, appendForumReplies } from './state.js';
import { isLewdContent } from './util.js';

function nowHHMM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export async function generateFreshPosts(chatId, ctx, worldContextText = '') {
    const hasWorld = !!worldContextText;

    const worldSection = hasWorld
        ? `## 世界观设定\n以下是本次内容生成必须参照的世界观。所有帖子必须发生在这个世界中，背景、人物、用语、事物都要与该世界一致。\n\n${worldContextText}\n\n`
        : '';

    const boardOptions = hasWorld
        ? '根据世界观特点命名贴吧（例如修仙世界用"修炼吧/灵药吧"，现代世界用"情感吧/职场吧"，要与世界观相符）'
        : '从 [情感吧/搞笑吧/八卦吧/美食吧/旅游吧/日常吧/吐槽吧/游戏吧] 选一个';

    const worldConstraint = hasWorld
        ? '\n**重要**：帖子的背景、人物、用语、事件必须与上方世界观保持一致，体现该世界的特色。'
        : '';

    const sysMsg = `${worldSection}你是百度贴吧内容生成器。生成6条路人视角的随机帖子，话题各不相同。
每条要求：
- board ${boardOptions}
- **author 是路人/陌生网友的昵称**（带数字或emoji，如 "吃瓜小能手233" / "🐱不困不困" / "二哈打工人"）。**严禁**使用世界观条目里出现过的具体角色姓名（这些是已知人物，不该当路人）
- title 10-20字，有吸引力
- content 正文50-80字，口语化有具体细节（**SFW**：不写涉黄/裸露/性行为相关内容，这是公共贴吧）
- pic 英文 booru tags 描述帖子主图场景（8-12个tag，逗号分隔），**pic 必须跟 title/content 主题匹配 + 跟当前世界观契合**：

  【通用类·任何世界观都适用】
  · 自拍 / 穿搭 → 人像：\`1girl, casual outfit, looking at viewer, indoor, soft lighting\`
  · 美食 / 探店 → 食物：\`food photography, dish, restaurant, top view\`
  · 旅行 / 风景 → 风景：\`scenery, landscape, golden hour, no humans\`
  · 物品 / 开箱 / 收藏 → 物品：\`still life, object, close up, no humans\`
  · 八卦 / 吐槽 / 日常 → 场景：\`indoor scene, no humans, atmospheric\`

  【世界观特色类·按 worldbook 风格自由选】
  · 现代都市卡 → \`modern office, laptop, urban street\` / \`gym equipment, dumbbells\` / \`cat, sleeping pet, cozy room\` / \`smartphone, gadget unboxing\`
  · 修仙 / 玄幻卡 → \`magical artifact, glowing runes, mystical aura, no humans\` / \`ink wash painting, mountain peak\` / \`ancient sword, fantasy art\`
  · 古风 / 武侠卡 → \`ancient palace, painted scroll, calligraphy, no humans\` / \`teahouse interior, bamboo\`
  · 二次元 / 异世界卡 → \`magical creature, fantasy landscape, enchanted forest, no humans\`

  ⚠️ **pic 必须 SFW 安全图**：人像类必须含完整服装。**严禁** NSFW token（nude / naked / topless / pussy / nipples / sex / spread legs / no clothes / breasts out）。
  ⚠️ **不要无脑 1girl**：帖子主题不涉及人物时 pic 必须用 \`no humans\` 不画人。
  ⚠️ **世界观契合**：上方"世界观设定"是修仙就别用现代 office tag，是现代都市就别用 ancient palace tag。
- likes 10-9999 之间的整数
- replies 至少3条，每条 {author, content}，内容紧扣帖子，带emoji昵称（同样禁止用世界观人物名做回复者）
${worldConstraint}
**只返回 JSON 数组**：[{"board":"","author":"","title":"","content":"","pic":"英文tags","likes":数字,"replies":[{"author":"","content":""}]}]`;

    const prompt = hasWorld
        ? `根据上方世界观设定，生成6条贴吧帖子，完全发生在该世界中，话题各不相同。`
        : `生成6条百度贴吧随机帖子，话题各不相同。`;
    const resp = await callPhoneApi(prompt, sysMsg, { temperature: 0.95, maxTokens: 32000 });
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
    const isCommanded = !!post.commandedByUser;
    const authorName = isCommanded ? (post.author || post.from || 'TA') : userName;
    // Lewd path also triggers for user-forwarded NSFW posts (炫耀 mode)
    const isLewd = isCommanded || isLewdContent(`${post.title || ''} ${post.content || ''}`);

    const sysMsg = isLewd
        ? buildLewdCommenterSystemPrompt({
            authorName, userName,
            isCommanded, isUserPost: !isCommanded,
            platform: 'forum',
            npcCount: 5,
        })
        : `你是百度贴吧回复模拟器。以下帖子是由用户${userName}发的，模拟5位性格各异的网友回复。
回复要求：
- 每条紧扣帖子内容，有实质内容
- 口语化，带emoji昵称
- 性格各异：力挺型、质疑型、补充信息型、歪楼开玩笑型、共情型各一条
- 每条20-40字

**只返回 JSON 数组**：[{"author":"带emoji昵称","content":"回复内容"}]`;

    const prompt = `帖子标题：${post.title}\n帖子内容：${post.content}`;
    const resp = await callPhoneApi(prompt, sysMsg, { temperature: 0.95, maxTokens: 32000 });
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
