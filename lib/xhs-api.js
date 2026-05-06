// XHS stranger-comment generation via separate phone API.
// Ported from mochi-phone's generateXHSStrangerComments.

import { callPhoneApi } from './phone-api.js';
import { findXhsPost, appendXhs, getChatState, save as saveState } from './state.js';
import { isLewdContent } from './util.js';

export async function generateStrangerComments(chatId, postId, ctx) {
    const post = findXhsPost(chatId, postId);
    // Allow user posts OR commanded-character posts (Phase D)
    if (!post) return false;
    if (post.from !== 'user' && !post.commandedByUser) return false;

    const isCommanded = !!post.commandedByUser;
    const userName = ctx?.name1 || '楼主';
    const authorName = isCommanded ? (post.user || post.from || 'TA') : userName;
    const charName = ctx?.name2 || ctx?.name || 'TA';
    const charLast = charName.split(/\s+/).pop() || charName;
    // Use lewd path also when forwarded post text is NSFW (user 炫耀 nude / 露骨 photos)
    const isLewd = isCommanded || isLewdContent(`${post.title || ''} ${post.body || ''}`);

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

    const sysMsg = isLewd
        ? `你是露骨小红书评论模拟器。这是一条**敏感/露骨笔记**，模拟 5 位**好色猥琐**的陌生网友评论。

帖子归属：
${isCommanded
    ? `- 表面作者：${authorName}（被她的"主人/老板"${userName}命令发出来公开露骨内容）\n- 真正主导者：${userName}（这是一种"展示我的女人"的炫耀+羞辱行为）`
    : `- 帖子由 ${userName} 本人发布，他在炫耀帖子里那个女人（推断为他的伴侣/战利品）的露骨照片，让所有人围观`}
${relationCtx ? relationCtx + '\n' : ''}
评论风格（**全部**好色猥琐，**禁止** SFW 关心、**禁止**"维护肖像权" / "举报" 类正义口吻）：
${isCommanded
    ? `1. 老色批围观型：直白下流赞叹（"这身材老板真有福气"）
2. 假正经下流型：嘴上"不该发这种"，字里行间舔得很
3. 跪舔崇拜型：把 ${authorName} 当女神，露骨意淫她被调教的样子
4. 阴阳羞辱型：嘲讽 ${authorName} "被调教得真听话" / "老板的乖母狗"
5. 同行眼红酸型：表演式酸"姐妹这身材怎么练的，也想被老板这样宠"`
    : `1. 老色批围观型：直白调戏图里那个女人 + 跪舔 ${userName}（"老板这战利品也太顶了"）
2. 嫉妒酸 ${userName} 型："凭什么是 ${userName} 的 ... 求带"
3. 羞辱被拍者型：嘲讽她被 ${userName} 这样曝光（"被你家主人公开露成这样" / "果然是某人的母狗"）
4. 求经验/求介绍型：装成同好向 ${userName} 求"调教经验" / "求加 V"
5. 见过世面老司机型：补充更下流的细节意淫（推断她还能拍什么更露骨的）`}

每条 20-40 字，emoji 昵称走猥琐风（🍑💦🤤🍆🥵🌸🐶🥒 等）。紧扣帖子露骨细节，不能回避。

**只返回 JSON 数组**：[{"user":"昵称","text":"评论内容"}]`
        : `你是一个小红书评论模拟器。以下帖子是由用户${userName}本人发的，模拟5位性格各异的陌生网友评论。

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

    const hasWorld = !!worldContextText;

    const worldSection = hasWorld
        ? `## 世界观设定\n以下是本次内容生成必须参照的世界观。所有帖子必须发生在这个世界中，背景、人物、用语、事物都要与该世界一致。\n\n${worldContextText}\n\n`
        : '';

    const tagOptions = hasWorld
        ? '根据世界观特点拟定标签（例如修仙世界用"修炼/灵药/秘境"，现代世界用"日常/情感/美食"，要与世界观相符）'
        : '从 [日常/穿搭/美食/旅行/情感/吐槽/八卦] 选一个';

    const worldConstraint = hasWorld
        ? '\n**重要**：帖子的背景、人物、用语、事件必须与上方世界观保持一致，体现该世界的特色。'
        : '';

    const sysMsg = `${worldSection}你是一个小红书内容生成器。生成6条**陌生人/路人**视角的随机帖子。
每条要求：
- **user 字段是陌生网友的昵称**（emoji + 通用网络昵称，如 🌸糖糖 / 🍵茶歇 / 🎀小满 / 🥑牛油果女孩 / 🍑果酱小姐）。**严禁**使用世界观条目里出现过的具体角色姓名（这些是已知人物，不该当陌生人）；陌生人就是网络路人 ID
- title 标题 8-15字
- body 正文 40-60字，口语化、有具体细节
- tag ${tagOptions}
- pic 英文 booru tag 描述帖子主配图场景（8-15个tag，逗号分隔），例：1girl, casual outfit, park, sunny day, looking at viewer
- likes 一个 100-9999 的数字
- comments 至少 3 条评论，每条 {user,text}，带emoji昵称（同样禁止用世界观人物名做评论者）
${worldConstraint}
**只返回 JSON 数组**：[{"user":"陌生网友emoji昵称","tag":"标签","title":"标题","body":"正文","pic":"english booru tags","likes":数字,"comments":[{"user":"昵称","text":"评论"}]}]`;

    const prompt = hasWorld
        ? `根据上方世界观设定，生成6条小红书帖子，完全发生在该世界中，话题各不相同。`
        : `生成6条小红书随机帖子，话题各不相同。`;
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
