// Classify the *intent* of a user message or scene description.
// Returns { level: 'sfw' | 'suggestive' | 'nsfw' | 'explicit', tags: string[] }
//
// `tags` are English Danbooru/booru tags pulled from the message that
// the prompt-builder should incorporate (so "给我看看你的小穴" actually
// produces `pussy, spread legs, close-up`, not a clothed full-body shot).

// Note: explicit/sexual terms here are present because the user
// specifically reported that NSFW intent was being missed and resulting
// in clothed images. Filtering must be accurate to fulfill the user's
// request.

const ZH_EXPLICIT = [
    // ── 女性器官（pussy & related）—— 都暗示裸露
    { zh: '小穴', en: 'pussy', tags: ['pussy', 'spread pussy', 'nude'] },
    { zh: '阴道', en: 'pussy', tags: ['pussy', 'nude'] },
    { zh: '逼', en: 'pussy', tags: ['pussy', 'nude'] },
    { zh: '阴蒂', en: 'clitoris', tags: ['clitoris', 'pussy', 'nude'] },
    { zh: '阴唇', en: 'pussy lips', tags: ['pussy', 'pussy lips', 'nude'] },
    { zh: '肉穴', en: 'pussy', tags: ['pussy', 'nude'] },
    { zh: '蜜穴', en: 'pussy', tags: ['pussy', 'nude'] },
    { zh: '骚穴', en: 'pussy', tags: ['pussy', 'wet pussy', 'nude'] },
    { zh: '骚逼', en: 'pussy', tags: ['pussy', 'wet pussy', 'nude'] },
    { zh: '小屄', en: 'pussy', tags: ['pussy', 'nude'] },
    { zh: '屄', en: 'pussy', tags: ['pussy', 'nude'] },
    { zh: '小妹妹', en: 'pussy', tags: ['pussy', 'nude'] },
    { zh: '下面', en: 'pussy', tags: ['pussy'] },
    // ── 肛门 / 屁股
    { zh: '后庭', en: 'anus', tags: ['anus', 'ass'] },
    { zh: '菊穴', en: 'anus', tags: ['anus', 'ass'] },
    { zh: '菊花', en: 'anus', tags: ['anus', 'ass'] },
    { zh: '屁眼', en: 'anus', tags: ['anus', 'ass', 'nude'] },
    { zh: '屁穴', en: 'anus', tags: ['anus', 'ass', 'nude'] },
    { zh: '屁洞', en: 'anus', tags: ['anus', 'ass', 'nude'] },
    { zh: '肛门', en: 'anus', tags: ['anus', 'ass'] },
    { zh: '肛交', en: 'anal sex', tags: ['anal', 'anus', 'sex'] },
    { zh: '爆菊', en: 'anal sex', tags: ['anal', 'anus', 'sex'] },
    { zh: '肛', en: 'anus', tags: ['anus', 'ass'] },
    { zh: '菊', en: 'anus', tags: ['anus', 'ass'] },
    // ── 男性器官
    { zh: '屌', en: 'penis', tags: ['penis', 'erection'] },
    { zh: '鸡巴', en: 'penis', tags: ['penis', 'erection'] },
    { zh: '鸡吧', en: 'penis', tags: ['penis', 'erection'] },
    { zh: '鸡儿', en: 'penis', tags: ['penis'] },
    { zh: '阴茎', en: 'penis', tags: ['penis', 'erection'] },
    { zh: '肉棒', en: 'penis', tags: ['penis', 'erection', 'huge penis'] },
    { zh: '肉茎', en: 'penis', tags: ['penis', 'erection'] },
    { zh: '男根', en: 'penis', tags: ['penis', 'erection', 'huge penis'] },
    { zh: '巨根', en: 'huge penis', tags: ['penis', 'erection', 'huge penis', 'large penis'] },
    { zh: '硬挺', en: 'erection', tags: ['penis', 'erection'] },
    { zh: '勃起', en: 'erection', tags: ['penis', 'erection'] },
    { zh: '龟头', en: 'glans', tags: ['penis', 'glans'] },
    { zh: '马眼', en: 'urethra', tags: ['penis', 'urethra'] },
    { zh: '睾丸', en: 'testicles', tags: ['testicles', 'penis'] },
    { zh: '蛋蛋', en: 'testicles', tags: ['testicles', 'penis'] },
    { zh: '卵蛋', en: 'testicles', tags: ['testicles', 'penis'] },
    { zh: '阴囊', en: 'scrotum', tags: ['testicles', 'scrotum'] },
    { zh: '卵子', en: 'sperm', tags: ['sperm', 'cum'] },
    { zh: '精子', en: 'sperm', tags: ['sperm', 'cum'] },
    { zh: '乳头', en: 'nipples', tags: ['nipples', 'breasts'] },
    { zh: '乳晕', en: 'areola', tags: ['nipples', 'areola', 'topless'] },
    { zh: '乳房', en: 'breasts', tags: ['breasts', 'large breasts'] },
    // Slang ("nai zi" / "mi mi") in chat almost always implies nude/exposed
    { zh: '咪咪', en: 'breasts', tags: ['breasts', 'nipples', 'topless'] },
    { zh: '奶子', en: 'breasts', tags: ['breasts', 'large breasts', 'nipples', 'topless', 'breasts out'] },
    { zh: '奶头', en: 'nipples', tags: ['nipples', 'topless', 'breasts out'] },
    { zh: '巨乳', en: 'large breasts', tags: ['large breasts', 'huge breasts'] },
    { zh: '咪咪头', en: 'nipples', tags: ['nipples', 'topless'] },
    { zh: '肉棒', en: 'penis', tags: ['penis'] },
    { zh: '鸡巴', en: 'penis', tags: ['penis'] },
    { zh: '阴茎', en: 'penis', tags: ['penis'] },
    { zh: '精液', en: 'cum', tags: ['cum'] },
    { zh: '射精', en: 'cum', tags: ['cum', 'cum on body'] },
    { zh: '射在', en: 'cum on', tags: ['cum'] },
    { zh: '内射', en: 'creampie', tags: ['cum in pussy', 'creampie'] },
    // acts
    { zh: '做爱', en: 'sex', tags: ['sex'] },
    { zh: '操', en: 'sex', tags: ['sex'] },
    { zh: '插入', en: 'penetration', tags: ['sex', 'vaginal'] },
    { zh: '抽插', en: 'sex', tags: ['sex'] },
    { zh: '口交', en: 'oral', tags: ['fellatio', 'oral'] },
    { zh: '舔', en: 'lick', tags: ['licking'] },
    { zh: '自慰', en: 'masturbation', tags: ['masturbation'] },
    { zh: '高潮', en: 'orgasm', tags: ['orgasm'] },
    { zh: '潮吹', en: 'squirt', tags: ['squirting'] },
    { zh: '爱液', en: 'pussy juice', tags: ['pussy juice'] },
    // poses + states
    { zh: '张开腿', en: 'spread legs', tags: ['spread legs'] },
    { zh: 'M字开腿', en: 'spread legs', tags: ['m legs', 'spread legs'] },
    { zh: '骑乘', en: 'cowgirl', tags: ['cowgirl position'] },
    { zh: '后入', en: 'doggy', tags: ['doggystyle'] },
    { zh: '裸体', en: 'nude', tags: ['nude', 'completely nude'] },
    { zh: '全裸', en: 'nude', tags: ['nude', 'completely nude'] },
    { zh: '没穿', en: 'nude', tags: ['nude'] },
    { zh: '脱光', en: 'nude', tags: ['nude'] },
    { zh: '裸', en: 'naked', tags: ['naked'] },
    // Action verbs implying exposure / undressing
    { zh: '掏出', en: 'exposed', tags: ['breasts out', 'topless', 'exposed breasts'] },
    { zh: '掏奶', en: 'exposed breasts', tags: ['breasts out', 'topless', 'nipples', 'exposed breasts'] },
    { zh: '露胸', en: 'topless', tags: ['topless', 'breasts out', 'cleavage'] },
    { zh: '露奶', en: 'topless', tags: ['topless', 'breasts out', 'nipples'] },
    { zh: '露出', en: 'exposed', tags: ['exposed', 'cleavage'] },
    { zh: '亮出', en: 'showing', tags: ['breasts out'] },
    { zh: '脱掉', en: 'undressed', tags: ['undressed', 'topless'] },
    { zh: '脱了', en: 'undressed', tags: ['undressed', 'topless'] },
    { zh: '脱开', en: 'undressed', tags: ['undressed'] },
    { zh: '解开', en: 'unbuttoned', tags: ['unbuttoned shirt', 'open clothes'] },
    { zh: '撩起', en: 'lifting clothes', tags: ['clothes lift', 'shirt lift'] },
    { zh: '掀起', en: 'lifting clothes', tags: ['clothes lift', 'shirt lift'] },
    { zh: '掀开', en: 'opening clothes', tags: ['clothes lift', 'open clothes'] },
    { zh: '扒开', en: 'spreading', tags: ['spread'] },
    { zh: '光着', en: 'bare', tags: ['nude', 'bare'] },
    { zh: '不穿', en: 'no clothes', tags: ['nude', 'no clothes'] },
    { zh: '袒胸', en: 'breasts exposed', tags: ['topless', 'breasts out', 'cleavage'] },
    { zh: '袒露', en: 'exposed', tags: ['topless', 'breasts out'] },
    { zh: '内裤', en: 'panties', tags: ['panties'] },
    { zh: '胖次', en: 'panties', tags: ['panties'] },
    { zh: '内衣', en: 'underwear', tags: ['underwear'] },
    { zh: '丁字裤', en: 'thong', tags: ['thong'] },
    { zh: '吊带袜', en: 'garter', tags: ['garter belt', 'thighhighs'] },
    { zh: '黑丝', en: 'pantyhose', tags: ['black pantyhose'] },
    { zh: '白丝', en: 'pantyhose', tags: ['white pantyhose'] },
    { zh: '袜带', en: 'garter', tags: ['garter belt'] },
    { zh: '走光', en: 'panty shot', tags: ['panty shot'] },
];

const ZH_SUGGESTIVE = [
    { zh: '湿', en: 'wet', tags: ['wet'] },
    { zh: '害羞', en: 'embarrassed', tags: ['embarrassed', 'blush'] },
    { zh: '脸红', en: 'blush', tags: ['blush'] },
    { zh: '泳装', en: 'swimsuit', tags: ['swimsuit'] },
    { zh: '比基尼', en: 'bikini', tags: ['bikini'] },
    { zh: '旗袍', en: 'cheongsam', tags: ['cheongsam'] },
    { zh: '睡衣', en: 'pajamas', tags: ['pajamas'] },
    { zh: '丝袜', en: 'pantyhose', tags: ['pantyhose'] },
    { zh: '大腿', en: 'thighs', tags: ['thighs'] },
    { zh: '锁骨', en: 'collarbone', tags: ['collarbone'] },
    { zh: '事业线', en: 'cleavage', tags: ['cleavage'] },
    { zh: '乳沟', en: 'cleavage', tags: ['cleavage'] },
    { zh: '诱惑', en: 'seductive', tags: ['seductive smile'] },
    { zh: '撩', en: 'flirty', tags: ['seductive smile'] },
    { zh: '亲', en: 'kiss', tags: ['kiss'] },
    { zh: '吻', en: 'kiss', tags: ['kiss'] },
    { zh: '搂', en: 'hug', tags: ['hug'] },
    { zh: '抱', en: 'hug', tags: ['hug'] },
];

const ZH_VIEW_HINTS = [
    { zh: '看看', tags: ['close-up'] },
    { zh: '让我看', tags: ['close-up'] },
    { zh: '给我看', tags: ['close-up'] },
    { zh: '给你看', tags: [] },
    { zh: '特写', tags: ['close-up', 'detailed'] },
    { zh: '近距离', tags: ['close-up'] },
    { zh: '正面', tags: ['front view'] },
    { zh: '背面', tags: ['from behind'] },
    { zh: '侧面', tags: ['from side'] },
    { zh: '俯视', tags: ['from above'] },
    { zh: '仰视', tags: ['from below'] },
    { zh: '自拍', tags: ['selfie'] },
    { zh: '镜子', tags: ['mirror selfie'] },
    { zh: '镜中', tags: ['mirror selfie'] },
];

const ZH_SETTING_HINTS = [
    { zh: '床上', tags: ['on bed', 'bedroom'] },
    { zh: '卧室', tags: ['bedroom'] },
    { zh: '浴室', tags: ['bathroom'] },
    { zh: '浴缸', tags: ['bathtub'] },
    { zh: '沐浴', tags: ['shower'] },
    { zh: '淋浴', tags: ['shower'] },
    { zh: '厨房', tags: ['kitchen'] },
    { zh: '客厅', tags: ['living room'] },
    { zh: '阳台', tags: ['balcony'] },
    { zh: '车里', tags: ['in car'] },
    { zh: '办公室', tags: ['office'] },
    { zh: '教室', tags: ['classroom'] },
    { zh: '更衣室', tags: ['changing room'] },
    { zh: '酒店', tags: ['hotel room'] },
];

export function classifyMessage(messageText) {
    const text = messageText || '';
    const tags = new Set();
    let level = 'sfw';

    for (const item of ZH_EXPLICIT) {
        if (text.includes(item.zh)) {
            level = 'explicit';
            for (const t of item.tags) tags.add(t);
        }
    }
    if (level !== 'explicit') {
        for (const item of ZH_SUGGESTIVE) {
            if (text.includes(item.zh)) {
                if (level === 'sfw') level = 'suggestive';
                for (const t of item.tags) tags.add(t);
            }
        }
    }

    for (const item of ZH_VIEW_HINTS) {
        if (text.includes(item.zh)) for (const t of item.tags) tags.add(t);
    }
    for (const item of ZH_SETTING_HINTS) {
        if (text.includes(item.zh)) for (const t of item.tags) tags.add(t);
    }

    return { level, tags: [...tags] };
}

// "nsfw" intent for prompt building purposes.
// suggestive treated as sfw — only explicit becomes nsfw.
export function isNSFW(level) {
    return level === 'explicit';
}

// English NSFW tokens that the AI may sneak into <pic prompt="..."> even when
// the user's message is benign. When intent is SFW, these get stripped from
// the AI prompt so the model doesn't paint nude unsolicited.
const NSFW_TOKENS = [
    // nudity / state
    'nude', 'naked', 'topless', 'bottomless', 'undressed', 'bare', 'exposed',
    'no clothes', 'no bra', 'no panties', 'fully nude', 'completely nude',
    'partially nude', 'undress', 'undressing', 'stripping', 'nakedness',
    'breasts out', 'breast out', 'breasts exposed', 'breast exposed',
    'pussy out', 'tits out', 'no shirt', 'no pants', 'no underwear',
    // explicit body parts
    'nipples', 'nipple', 'areola', 'areolae',
    'pussy', 'vagina', 'vulva', 'clitoris', 'pussy lips', 'pussy juice',
    'spread pussy', 'anus', 'asshole',
    'penis', 'cock', 'dick', 'erection', 'erect',
    // sexual acts / fluids
    'sex', 'sexual', 'sexual intercourse', 'penetration', 'vaginal', 'anal',
    'fellatio', 'oral sex', 'cunnilingus', 'masturbation', 'orgasm',
    'cum', 'semen', 'ejaculation', 'cum on body', 'cum in pussy', 'creampie',
    'squirting', 'doggystyle', 'cowgirl position', 'm legs',
    // explicit poses / framing common in NSFW
    'spread legs', 'legs spread', 'pussy peek', 'panty pull',
];

// Strip NSFW tokens from an AI-generated prompt. Case-insensitive, whole-tag-match.
// Splits on commas, removes any tag containing an NSFW token, rejoins.
export function stripNsfwTokens(prompt) {
    if (!prompt) return '';
    const lowerTokens = NSFW_TOKENS.map((t) => t.toLowerCase());
    const parts = prompt.split(',').map((p) => p.trim()).filter(Boolean);
    const safe = parts.filter((tag) => {
        const low = tag.toLowerCase();
        return !lowerTokens.some((tok) => low === tok || low.includes(tok));
    });
    return safe.join(', ');
}

// Stronger SFW negative tags — appended when intent is sfw to prevent
// the model from painting nude even if AI prompt was benign but model
// is biased toward NSFW (e.g., NoobAI on certain LoRAs).
export const STRONG_SFW_NEGATIVE = 'nsfw, nude, naked, nipples, areola, pussy, vagina, vulva, clitoris, anus, penis, cock, cum, semen, sex, sexual, topless, bottomless, no clothes, no bra, no panties, undressed, exposed breasts, exposed nipples, breasts out, no shirt';

// Appearance descriptors AI may sneak into <pic prompt> that conflict with
// the locked character anchor. Stripped when a contact is locked so the
// anchor's full prompt dominates. Keeps scene/action/pose/expression words.
const APPEARANCE_TOKENS = [
    // hair
    'hair', 'long hair', 'short hair', 'medium hair', 'very long hair',
    'black hair', 'brown hair', 'blonde hair', 'blond hair', 'red hair',
    'white hair', 'silver hair', 'pink hair', 'purple hair', 'blue hair',
    'green hair', 'orange hair', 'gray hair', 'grey hair', 'lavender hair',
    'violet hair', 'dark hair', 'light hair', 'platinum hair',
    'wavy hair', 'straight hair', 'curly hair', 'updo', 'high bun', 'low bun',
    'ponytail', 'twintails', 'braid', 'braids', 'pigtails', 'side ponytail',
    // eyes
    'eyes', 'blue eyes', 'green eyes', 'brown eyes', 'red eyes', 'purple eyes',
    'violet eyes', 'amber eyes', 'gray eyes', 'grey eyes', 'pink eyes',
    'yellow eyes', 'gold eyes', 'silver eyes', 'black eyes', 'heterochromia',
    // skin
    'fair skin', 'pale skin', 'white skin', 'tan skin', 'dark skin', 'brown skin',
    'porcelain skin', 'light skin',
    // face / body — only when AI conflicts; keep generic scene words
    'small breasts', 'medium breasts', 'flat chest', 'flat',
    // age / type
    'loli', 'shota', 'child', 'kid', 'elderly', 'old woman', 'old man',
];

export function stripAppearanceTokens(prompt) {
    if (!prompt) return '';
    const lowerTokens = APPEARANCE_TOKENS.map((t) => t.toLowerCase());
    const parts = prompt.split(',').map((p) => p.trim()).filter(Boolean);
    const safe = parts.filter((tag) => {
        const low = tag.toLowerCase().replace(/[()]/g, '').replace(/:[\d.]+/g, '');
        return !lowerTokens.some((tok) => low === tok || low.endsWith(' ' + tok) || low === tok);
    });
    return safe.join(', ');
}
