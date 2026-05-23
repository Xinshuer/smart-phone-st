// 小红书 (XHS) — 仿真 UI：瀑布流卡片 + 详情页 + 发帖
import { getChatState } from '../state.js';
import { escapeHtml, renderImagesGrid, readPostImages, isImageUrl } from '../util.js';

export const TAGS = ['日常', '穿搭', '美食', '旅行', '情感', '吐槽', '八卦', '美妆'];

const TAG_PROMPTS = {
    '穿搭': '1girl, fashion outfit, full body, looking at viewer, white background, posing',
    '美食': 'food photography, dish, restaurant, appetizing, top view, soft lighting',
    '旅行': 'scenery, travel photography, outdoor landscape, natural lighting, wide shot',
    '情感': '1girl, portrait, close up, soft expression, warm lighting, bokeh',
    '美妆': '1girl, beauty makeup, face close up, cosmetics, soft studio lighting',
    '日常': '1girl, casual, daily life, indoor, soft lighting, lifestyle',
    '吐槽': '1girl, indoor, casual selfie angle, slight smile',
    '八卦': '1girl, candid, social media style, outdoor',
};

function makeFallbackPicTag(post) {
    const base = TAG_PROMPTS[post.tag] || '1girl, lifestyle photo, soft lighting, casual';
    return `<pic prompt="${base}"/>`;
}

let activeView = 'feed'; // 'feed' | 'compose' | 'detail'
let activeDetailId = null;
let composeTag = '日常';

export function getActiveView() { return activeView; }
export function getActiveDetailId() { return activeDetailId; }
export function setView(v, id = null) { activeView = v; activeDetailId = id; }

export function renderXHS(chatId) {
    if (activeView === 'compose') return renderCompose();
    if (activeView === 'detail') return renderDetail(chatId, activeDetailId);
    return renderFeed(chatId);
}

function renderFeed(chatId) {
    const cs = getChatState(chatId);
    const feed = (cs.xhs || []).slice().reverse();
    return `
        <div class="xhs-wrap">
            <div class="xhs-nav">
                <span class="xhs-nav-logo">小红书</span>
                <button id="xhs-refresh-btn" class="xhs-nav-icon" title="刷新">🔄</button>
                <button id="xhs-clear-btn" class="xhs-nav-icon" title="清空并重生成">🗑️</button>
                <button id="xhs-compose-btn" class="xhs-nav-compose">✏️ 发笔记</button>
            </div>
            ${feed.length === 0
                ? '<div class="phone-empty">还没有笔记<br><small>点「发笔记」或「🔄」让网友发帖</small></div>'
                : `<div class="xhs-feed">${feed.map(renderCard).join('')}</div>`
            }
        </div>
    `;
}

// v0.14.76 渲染 feed 卡片预览图。
// 设计原则：**只对已有 URL 的图片**（user 上传 / AI 命令发帖附图）渲染预览，
// **不**对 pic prompt 类自动 fire ComfyUI —— 否则 feed 6 卡同时刷会同时跑 6 次
// ComfyUI 调用，资源浪费严重。pic prompt 类继续走 shimmer 占位，user 点进
// 详情页才真正生成。
function renderCardImg(p) {
    const images = readPostImages(p);
    if (!images.length) return ''; // 没图 → shimmer 兜底
    const first = images[0];
    if (isImageUrl(first)) {
        return `<img class="phone-pic" src="${escapeHtml(first)}" loading="lazy">`;
    }
    // pic prompt 类（自动刷新 feed 帖）—— **故意不**渲染 slot 避免 triggerPicSlots
    // 自动 fire ComfyUI。详情页才 render & 生成。
    return '';
}

function renderCard(p) {
    const userInitial = escapeHtml((p.user || '匿名').slice(0, 1));
    const mineBadge = p.from === 'user' ? '<span class="xhs-mine-badge">我的</span>' : '';
    return `
        <div class="xhs-card" data-postid="${escapeHtml(p.id)}">
            <div class="xhs-card-img">${renderCardImg(p)}</div>
            <div class="xhs-card-footer">
                <div class="xhs-card-title">${escapeHtml(p.title || p.body.slice(0, 24))}${mineBadge}</div>
                <div class="xhs-card-meta">
                    <div class="xhs-card-avatar">${userInitial}</div>
                    <span class="xhs-card-user">${escapeHtml(p.user || '匿名')}</span>
                    <span class="xhs-card-likes">❤ ${p.likes || 0}</span>
                </div>
            </div>
        </div>
    `;
}

function renderCompose() {
    return `
        <div class="xhs-compose">
            <div class="phone-thread-header">
                <button class="phone-back" data-back-to-feed>‹</button>
                <span class="phone-thread-title">发笔记</span>
            </div>
            <input id="xhs-post-title" type="text" class="phone-input" placeholder="标题（可空）" maxlength="40">
            <textarea id="xhs-post-body" class="phone-input" rows="6" placeholder="说点什么..." maxlength="500"></textarea>
            <div class="xhs-tag-row">
                ${TAGS.map((t) => `<button class="xhs-tag-btn ${t === composeTag ? 'selected' : ''}" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')}
            </div>
            <button id="xhs-submit-btn" class="xhs-cta-primary">发布</button>
        </div>
    `;
}

function renderDetail(chatId, postId) {
    const cs = getChatState(chatId);
    const p = (cs.xhs || []).find((x) => x.id === postId);
    if (!p) return `<div class="phone-empty">笔记不存在</div>`;

    const fallbackTag = makeFallbackPicTag(p);
    const allImages = readPostImages(p);
    const imagesForGrid = allImages.length > 0 ? allImages : [fallbackTag];
    const sourceFlag = p.from === 'user' ? 'xhs_user' : (p.commandedByUser ? 'xhs_command' : 'xhs');
    const userInitial = escapeHtml((p.user || '匿名').slice(0, 1));
    const comments = (p.comments || []).map((c) => `
        <div class="xhs-comment">
            <span class="xhs-comment-user">${escapeHtml(c.user || c.from || '匿名')}</span>
            <span class="xhs-comment-text">${escapeHtml(c.text || '')}</span>
            <span class="xhs-comment-time">${escapeHtml(c.time || '')}</span>
        </div>
    `).join('');

    return `
        <div class="xhs-detail">
            <div class="xhs-detail-topbar">
                <button class="phone-back" data-back-to-feed>‹</button>
                <div class="xhs-detail-author-bar">
                    <div class="xhs-author-av">${userInitial}</div>
                    <span class="xhs-author-name">@${escapeHtml(p.user || '匿名')}</span>
                </div>
                <span class="xhs-follow">关注</span>
            </div>
            <div class="xhs-detail-img-wrap">
                ${renderImagesGrid(imagesForGrid, {
                    hint: p.user || '',
                    context: (p.title || '') + ' ' + (p.body || ''),
                    source: sourceFlag,
                    allowReroll: true,
                })}
            </div>
            <div class="xhs-detail-content">
                <div class="xhs-detail-title">${escapeHtml(p.title || '')}</div>
                <span class="xhs-tag-pill">#${escapeHtml(p.tag || '日常')}</span>
                <div class="xhs-detail-body">${escapeHtml(p.body)}</div>
                <div class="xhs-detail-time">${escapeHtml(p.time || '')}${p.date ? ' · ' + escapeHtml(p.date) : ''}</div>
            </div>
            <div class="xhs-detail-actions">
                <span>❤ ${p.likes || 0}</span>
                <span>💬 ${(p.comments || []).length} 条评论</span>
            </div>
            <div class="xhs-comments">
                <div class="xhs-comments-title">评论 (${(p.comments || []).length})</div>
                ${comments || '<div class="phone-empty-inline">还没人评论</div>'}
            </div>
        </div>
    `;
}

// onRerollPic removed — reroll now handled globally in index.js (matches `.phone-img-reroll-btn`)
export function bindXHSHandlers(root, { onCompose, onRefresh, onClear, onOpenPost, onBackToFeed, onSubmit, onTagSelect }) {
    root.querySelector('#xhs-compose-btn')?.addEventListener('click', onCompose);
    root.querySelector('#xhs-refresh-btn')?.addEventListener('click', onRefresh);
    root.querySelector('#xhs-clear-btn')?.addEventListener('click', onClear);
    root.querySelectorAll('.xhs-card').forEach((el) => {
        el.addEventListener('click', () => onOpenPost(el.dataset.postid));
    });
    root.querySelector('[data-back-to-feed]')?.addEventListener('click', onBackToFeed);
    root.querySelector('#xhs-submit-btn')?.addEventListener('click', () => {
        const title = root.querySelector('#xhs-post-title')?.value.trim() || '';
        const body = root.querySelector('#xhs-post-body')?.value.trim() || '';
        if (!body) { toastr.warning('请输入内容'); return; }
        onSubmit({ title, body, tag: composeTag });
    });
    root.querySelectorAll('.xhs-tag-btn').forEach((b) => {
        b.addEventListener('click', () => {
            composeTag = b.dataset.tag;
            root.querySelectorAll('.xhs-tag-btn').forEach((x) => x.classList.toggle('selected', x === b));
            onTagSelect && onTagSelect(composeTag);
        });
    });
}
