export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function html(strings, ...values) {
    return strings.reduce((acc, s, i) => acc + s + (i < values.length ? escapeHtml(values[i]) : ''), '');
}

// ─────────────────────────────────────────────────────────────────────────
// Multi-image grid rendering (used by moments / forum / xhs / messages)
//
// Each item in `images` array is either:
//   - a URL ('http://…' / 'https://…' / 'data:…') — already-resolved image, render <img> directly
//   - a picTag ('<pic prompt="…"/>') — needs ComfyUI generation, render phone-image-slot
//
// Layout follows WeChat 朋友圈 conventions:
//   1 image  → single large
//   2-3      → row
//   4        → 2×2
//   5-9      → 3-col grid
//
// Inputs:
//   images:    string[]  (URLs or picTags)
//   options:   { hint?: string, context?: string, source?: string, allowReroll?: boolean }
//   options.hint     — author name (for resolveContact)
//   options.context  — post body (for resolveContact fallback + intent classification)
//   options.source   — 'moments' / 'moments_command' / 'moments_forward' / 'forum' / 'xhs' (NSFW gate)
//   options.allowReroll — if true, render reroll button overlay on slots that support it
// ─────────────────────────────────────────────────────────────────────────
export function isImageUrl(s) {
    if (!s || typeof s !== 'string') return false;
    return /^(https?:\/\/|data:image\/)/i.test(s.trim());
}

export function isPicTag(s) {
    if (!s || typeof s !== 'string') return false;
    return /^<pic\b/i.test(s.trim());
}

export function gridClassFor(n) {
    if (n <= 1) return 'phone-img-grid-1';
    if (n === 2 || n === 3) return `phone-img-grid-${n}`;
    if (n === 4) return 'phone-img-grid-4';
    return 'phone-img-grid-9'; // 5-9
}

export function renderImagesGrid(images, options = {}) {
    if (!Array.isArray(images) || images.length === 0) return '';
    // v0.14.0 加 subjects 选项 — 群聊多角色合影时由 SUBJECTS 属性透传到下游 generateGroupPicTag
    // v0.14.41 加 subject 单数选项 — SMS 里 A 发 B 的照片时，pic 标签 SUBJECT="B" 让 plugin
    // 按 B 解析 anchor 而不是 A。subject 优先级高于 hint（覆盖 hint.from）。
    // v0.14.78 加 feedPostId/feedPlatform — feed 帖子（xhs/moments/forum）触发出图后，
    // triggerPicSlots 把 URL 写回 post.images，让下次 render 直接 <img>（跳过 slot+生成全套，
    // 修"退帖重进又生成新图"bug）。
    let { hint = '', context = '', source = '', allowReroll = false, subjects = '', subject = '',
          feedPostId = '', feedPlatform = '' } = options;
    if (subject) hint = subject; // 单数 subject 覆盖 hint，让下游按 subject 找 anchor
    const hintAttr = `data-hint="${escapeHtml(hint)}"`;
    const ctxAttr = `data-context="${escapeHtml(context)}"`;
    const srcAttr = source ? ` data-source="${escapeHtml(source)}"` : '';
    const subjectsAttr = subjects ? ` data-subjects="${escapeHtml(subjects)}"` : '';
    const feedAttr = (feedPostId && feedPlatform)
        ? ` data-feed-post-id="${escapeHtml(feedPostId)}" data-feed-platform="${escapeHtml(feedPlatform)}"`
        : '';

    const cells = images.slice(0, 9).map((entry, idx) => {
        if (isImageUrl(entry)) {
            // Already-resolved image (forwarded / user-attached) — render directly, no ComfyUI
            return `<div class="phone-img-cell">
                <img class="phone-pic" src="${escapeHtml(entry)}" loading="lazy">
            </div>`;
        }
        if (isPicTag(entry)) {
            const rerollBtn = allowReroll
                ? `<button class="phone-img-reroll-btn" data-pic="${escapeHtml(entry)}" title="重新生成">🔄</button>`
                : '';
            const idxAttr = feedAttr ? ` data-feed-img-idx="${idx}"` : '';
            return `<div class="phone-img-cell">
                <div class="phone-image-slot" data-pic="${escapeHtml(entry)}" ${hintAttr} ${ctxAttr}${srcAttr}${subjectsAttr}${feedAttr}${idxAttr}>📷 生成中…</div>
                ${rerollBtn}
            </div>`;
        }
        // Unknown — skip
        return '';
    }).filter(Boolean).join('');

    return `<div class="phone-img-grid ${gridClassFor(images.length)}">${cells}</div>`;
}

// Read post images: prefer new images[] field, fall back to legacy single pic field
export function readPostImages(post) {
    if (Array.isArray(post?.images) && post.images.length) return post.images;
    if (post?.pic) return [post.pic];
    return [];
}

// Detect lewd/NSFW content from Chinese title/body text. Used by comment generators to
// switch to "好色猥琐" mode whenever a forwarded post is NSFW (not just commanded posts).
const LEWD_KEYWORDS = /(露|奶|穴|逼|骚|淫|裸|脱|乳|乳头|乳房|乳沟|内衣|内裤|胖次|丁字裤|奶子|咪咪|挨操|高潮|湿|潮吹|射|爆乳|开腿|张腿|羞耻|性奴|肉便器|淫娃|母狗|爱液|阴|肛|菊|后入|骑乘|颜射|内射|口爆|乳交|足交|手交|胸推|奶推|挑逗|诱惑|勾引|发情|发骚)/;
export function isLewdContent(text) {
    if (!text || typeof text !== 'string') return false;
    return LEWD_KEYWORDS.test(text);
}

// v0.14.0 群聊气泡渲染辅助：构造发送者标签 HTML（每条 NPC 气泡顶上显示）
// 已删除成员加 (已删除) 标记
export function renderGroupSenderLabel(name, isDeleted = false) {
    const tag = isDeleted ? ' <span class="wc-sender-deleted">(已删除)</span>' : '';
    return `<div class="wc-sender-name">${escapeHtml(name)}${tag}</div>`;
}

// 构造群头像 HTML：渐变方块 + 群名首 1-2 字（mochi 风）
const GROUP_GRADIENTS = [
    ['#6a82fb', '#fc5c7d'],
    ['#43e97b', '#38f9d7'],
    ['#fa709a', '#fee140'],
    ['#30cfd0', '#330867'],
    ['#a8edea', '#fed6e3'],
    ['#ff9a9e', '#fad0c4'],
];
export function renderGroupAvatar(name, size = 36) {
    const idx = (String(name || '').charCodeAt(0) || 0) % GROUP_GRADIENTS.length;
    const [c1, c2] = GROUP_GRADIENTS[idx];
    const initials = String(name || '?').slice(0, 2);
    const fontSize = Math.floor(size * 0.4);
    return `<div class="phone-group-avatar" style="width:${size}px;height:${size}px;background:linear-gradient(135deg,${c1},${c2});font-size:${fontSize}px;">${escapeHtml(initials)}</div>`;
}
