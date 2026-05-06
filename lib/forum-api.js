// 论坛 (贴吧) AI 内容生成 — 帖子 & 回复
import { callPhoneApi } from './phone-api.js';
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
- content 正文50-80字，口语化有具体细节
- pic 英文 booru tags 描述帖子主图场景（8-12个tag，逗号分隔），例：1girl, casual outfit, park, sunny day
- likes 10-9999 之间的整数
- replies 至少3条，每条 {author, content}，内容紧扣帖子，带emoji昵称（同样禁止用世界观人物名做回复者）
${worldConstraint}
**只返回 JSON 数组**：[{"board":"","author":"","title":"","content":"","pic":"英文tags","likes":数字,"replies":[{"author":"","content":""}]}]`;

    const prompt = hasWorld
        ? `根据上方世界观设定，生成6条贴吧帖子，完全发生在该世界中，话题各不相同。`
        : `生成6条百度贴吧随机帖子，话题各不相同。`;
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
    const isCommanded = !!post.commandedByUser;
    const authorName = isCommanded ? (post.author || post.from || 'TA') : userName;
    // Lewd path also triggers for user-forwarded NSFW posts (炫耀 mode)
    const isLewd = isCommanded || isLewdContent(`${post.title || ''} ${post.content || ''}`);

    const sysMsg = isLewd
        ? `你是百度贴吧露骨回复模拟器。这是一个**敏感/露骨帖子**，模拟 5 位**好色猥琐**的网友回复。

帖子归属：
${isCommanded
    ? `- 表面作者：${authorName}（被她的"主人/老板"${userName}命令发出来公开露骨内容）\n- 真正主导者：${userName}（"展示我的女人"的炫耀+羞辱）`
    : `- 帖子由 ${userName} 本人发布，他在炫耀帖子里那个女人（推断为他的伴侣/战利品）的露骨内容，让所有人围观`}

回复风格（**全部**好色猥琐，**禁止** SFW 围观、**禁止**正义口吻）：
${isCommanded
    ? `1. 老色批围观型：直白调戏 ${authorName}（"这身材老板真有福气"）
2. 阴阳羞辱型：嘲讽 ${authorName} "被调教得真听话" / "老板的乖母狗"
3. 跪舔崇拜型：极端崇拜 + 露骨意淫她被使用的样子
4. 同行眼红型：表演式酸+暗示自己也愿意被这样调教
5. 见过世面老司机型：补充更露骨的猜测细节`
    : `1. 老色批围观型：直白调戏图/帖里那个女人 + 跪舔 ${userName}（"老板这战利品太顶了"）
2. 嫉妒酸 ${userName} 型："凭什么是 ${userName} 的 ... 求带"
3. 羞辱被曝者型：嘲讽她被 ${userName} 这样公开（"果然是某人的母狗"）
4. 求经验/求介绍型：装成同好向 ${userName} 求"调教经验" / "求加 V"
5. 见过世面老司机型：补充更下流的细节意淫`}

每条 20-40 字，emoji 昵称走猥琐风（🍑💦🤤🍆 等）。紧扣帖子露骨内容。

**只返回 JSON 数组**：[{"author":"带emoji昵称","content":"回复内容"}]`
        : `你是百度贴吧回复模拟器。以下帖子是由用户${userName}发的，模拟5位性格各异的网友回复。
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
