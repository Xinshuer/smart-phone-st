// XHS stranger-comment generation via separate phone API.
// Ported from mochi-phone's generateXHSStrangerComments.

import { callPhoneApi } from './phone-api.js';
import { findXhsPost, appendXhs, getChatState, save as saveState } from './state.js';
import { isLewdContent } from './util.js';
import { buildLewdCommenterSystemPrompt } from './lewd-commenter.js';

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
        ? buildLewdCommenterSystemPrompt({
            authorName, userName,
            isCommanded, isUserPost: !isCommanded,
            platform: 'xhs',
            npcCount: 5,
        }) + (relationCtx ? `\n\n# 角色背景参考\n${relationCtx}` : '')
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
    const resp = await callPhoneApi(prompt, sysMsg, { temperature: 0.95, maxTokens: 32000 });
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

    const nicknameGuide = hasWorld
        ? '**user 字段是陌生网友的昵称，必须跟当前世界观风格契合**（**严禁**使用世界观条目里出现过的具体角色姓名）。参考分类：\n' +
          '    · 现代都市世界 → emoji + 网络 ID：🌸糖糖 / 🥑牛油果女孩 / 🍑果酱小姐 / 🍵茶歇 / 🎀小满\n' +
          '    · 修仙 / 玄幻世界 → 修真风 ID：散修甲 / 灵犀子 / 山中道童 / 路过的炼器宗弟子 / 玄阳道君 / 三千年的乌龟\n' +
          '    · 古风 / 武侠世界 → 古风风 ID：江南某书生 / 茶馆掌柜 / 萍水相逢的游侠 / 某琴师 / 街角说书人 / 某无名江湖客\n' +
          '    · 二次元 / 异世界 → 奇幻风 ID：谜之冒险者 / 神秘魔法师 / 旅行者 / 某矮人匠人 / 路过的精灵 / 某S级冒险者\n' +
          '    上方"世界观设定"是哪类就挑哪类，**严禁**修仙世界出 🍑果酱小姐、现代世界出 玄阳道君'
        : '**user 字段是陌生网友的昵称**（emoji + 通用网络昵称，如 🌸糖糖 / 🍵茶歇 / 🎀小满 / 🥑牛油果女孩 / 🍑果酱小姐）。**严禁**使用世界观条目里出现过的具体角色姓名（这些是已知人物，不该当陌生人）；陌生人就是网络路人 ID';

    const sysMsg = `${worldSection}你是一个小红书内容生成器。生成6条**陌生人/路人**视角的随机帖子。
每条要求：
- ${nicknameGuide}
- title 标题 8-15字
- body 正文 40-60字，口语化、有具体细节（**SFW**：不写涉黄/裸露/性行为相关内容，这是公共社区）
- tag ${tagOptions}
- pic 英文 booru tag 描述帖子主配图场景（8-15个tag，逗号分隔），**pic 必须跟 title/body 主题匹配 + 跟当前世界观契合**，参考分类：

  【🧠 构图推理铁律 — 像真人选图那样想】

  写 pic 前，**先停下来反问自己 3 个问题**（不需要输出推理过程，只输出 JSON）：

  **问题 1：现实生活中，类似主题的小红书帖会配什么图？**
  - 想象一个真实小红书博主发这条帖子，她/他会拍什么？
  - 例："今天炼丹失败了 3 次"——真人会拍**爆炸的炉子/失败的丹药近景**，不会自拍
  - 例："今日穿搭"——真人会拍**镜子前自拍/全身镜照**
  - 例："师姐又骂我"——真人会拍**师姐背影抓拍**或**自己郁闷自拍**或**师姐房门照**

  **问题 2：帖子的焦点是谁/什么？**
  - 焦点 = 发帖人自己 → 自拍/写真 OK
  - 焦点 = 物品/食物/景物 → no humans 或物品近景
  - 焦点 = 别人（师尊/朋友/路人）→ 第三人称视角拍那个人
  - 焦点 = 事件场景 → 抓拍/广角/候选物拍

  **问题 3：avoid anime SDXL 默认 1girl-自拍 bias**
  anime 模型有强烈 1girl-front-portrait prior。**主动用视角 tag 抗 bias**：
  - 物品类：\`no humans, close up\`
  - 景观类：\`no humans, scenery, wide shot\`
  - 第三人称：\`from behind\` / \`from side\` / \`candid photo\` / \`third person view\`
  - 物品 + 手：\`close up, hands focus, holding object, partial body\`（半身露手，不露脸）
  - 抓拍：\`candid photo, telephoto, from a distance, voyeur angle\`
  - **仅** OOTD/穿搭/美妆/打卡自拍 用 \`mirror selfie, looking at viewer\`

  ⚠️ 避免：性行为场景写 selfie / 物品炫耀写 1girl / 旁观叙事写 selfie。

  【参考真实小红书配图模式（按主题）】
  · 美食探店 → 食物 top-down 大图 / 餐厅环境 / 半身手持食物
  · 穿搭 OOTD → mirror selfie / 衣物平铺 / 全身镜照
  · 美妆教程 → 脸部特写 / 化妆品平铺
  · 旅行打卡 → 景点宽镜 / 背影看风景 / 局部建筑特写
  · 物品开箱/炫耀 → 物品近景 / 手捧物品 / 物品+包装
  · 抓拍八卦 → 路人远景 / 第三人称偷拍角度
  · 心情日记 → mood photo（咖啡/书桌/猫/窗/雨）/ 1girl 侧脸沉思
  · 测评/教程 → 物品对比图 / 操作步骤截图

  【世界观特色类·按 worldbook 风格自由选】
  · 现代都市卡 → 数码 / 职场 / 健身 / 萌宠 / 装修 / 追剧 等：\`modern office, laptop, urban street\` / \`gym equipment, dumbbells\` / \`cat, sleeping pet, cozy room\` / \`smartphone, gadget unboxing\`
  · 修仙 / 玄幻卡 → 法宝 / 灵物 / 秘境：\`magical artifact, glowing runes, mystical aura, no humans\` / \`ink wash painting, mountain peak, immortal aesthetic\` / \`ancient sword, fantasy art\`
  · 古风 / 武侠卡 → 古风物：\`ancient palace, painted scroll, calligraphy, traditional setting, no humans\` / \`teahouse interior, bamboo, ink painting\`
  · 二次元 / 异世界卡 → 奇幻物：\`magical creature, fantasy landscape, enchanted forest, no humans\` / \`floating island, aurora, dreamy\`

  ⚠️ **pic 必须 SFW 安全图**：人像类必须含完整服装（casual outfit / dress / shirt 等），**严禁** NSFW token（nude / naked / topless / pussy / nipples / sex / spread legs / no clothes / breasts out）。小红书 feed 是匿名公共社区。
  ⚠️ **不要无脑 1girl**：帖子主题不涉及人物（美食/物品/风景/法宝）时 pic 必须用 \`no humans\` 不画人。
  ⚠️ **世界观契合**：上方"世界观设定"是修仙就别用现代 office tag，是现代都市就别用 ancient palace tag。
- likes 一个 100-9999 的数字
- comments 至少 3 条评论，每条 {user,text}，带emoji昵称（同样禁止用世界观人物名做评论者）
${worldConstraint}
**只返回 JSON 数组**：[{"user":"陌生网友emoji昵称","tag":"标签","title":"标题","body":"正文","pic":"english booru tags","likes":数字,"comments":[{"user":"昵称","text":"评论"}]}]`;

    const prompt = hasWorld
        ? `根据上方世界观设定，生成6条小红书帖子，完全发生在该世界中，话题各不相同。`
        : `生成6条小红书随机帖子，话题各不相同。`;
    const resp = await callPhoneApi(prompt, sysMsg, { temperature: 0.95, maxTokens: 32000 });
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
