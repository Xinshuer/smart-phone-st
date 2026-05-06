// 朋友圈 — 微信朋友圈风格：联系人动态 + 发动态 + 点赞 + 评论
import { getChatState } from '../state.js';
import { escapeHtml, renderImagesGrid, readPostImages } from '../util.js';

let momentsView = 'feed'; // 'feed' | 'compose'

export function getMomentsView() { return momentsView; }
export function setMomentsView(v) { momentsView = v; }

export function renderMoments(chatId, contacts, userName) {
    if (momentsView === 'compose') return renderCompose();
    return renderFeed(chatId, contacts, userName);
}

function renderFeed(chatId, contacts, userName) {
    const cs = getChatState(chatId);
    const posts = (cs.moments || []).slice().reverse();

    const contactMap = {};
    for (const c of (contacts || [])) contactMap[c.name] = c;

    const initial = escapeHtml((userName || '我').slice(-1));

    const coverHtml = `
        <div class="moments-cover">
            <div class="moments-cover-bg"></div>
            <div class="moments-cover-profile">
                <span class="moments-cover-name">${escapeHtml(userName || '我')}</span>
                <div class="moments-cover-av">${initial}</div>
            </div>
        </div>`;

    const feedHtml = posts.length === 0
        ? '<div class="phone-empty" style="padding:40px 20px">还没有动态<br><small>点「刷新」让联系人发朋友圈</small></div>'
        : posts.map((p) => renderMomentCard(p, contactMap[p.from] || null, userName)).join('');

    return `
        <div class="moments-wrap">
            ${coverHtml}
            <div class="moments-toolbar">
                <button id="moments-compose-btn" class="moments-toolbar-btn">📝 发动态</button>
                <button id="moments-refresh-btn" class="moments-toolbar-btn">🔄 刷新</button>
                <button id="moments-clear-btn" class="moments-toolbar-btn">🗑️ 清空重生成</button>
            </div>
            <div class="moments-feed">
                ${feedHtml}
            </div>
        </div>`;
}

function renderMomentCard(p, contact, userName) {
    const isMe = p.from === 'user';
    const displayName = isMe ? (userName || '我') : (p.authorName || p.from || '联系人');
    const initial = escapeHtml(String(displayName).slice(-1));

    const refImg = !isMe && contact?.anchor?.referenceImage;
    const avHtml = refImg
        ? `<img class="moments-av" src="${escapeHtml(refImg)}" alt="${initial}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
        : '';
    const avFallback = `<div class="moments-av" style="${avHtml ? 'display:none' : ''}">${initial}</div>`;

    // Auto-refresh moments use 'moments' source (force SFW). User/command/forward posts pass through URLs (no AI gen, no SFW gate fires).
    const sourceFlag = p.from === 'user' ? 'moments_user' : (p.commandedByUser ? 'moments_command' : 'moments');
    const picHtml = renderImagesGrid(readPostImages(p), {
        hint: p.from || '',
        context: p.content || '',
        source: sourceFlag,
        allowReroll: true,
    });

    const locationHtml = p.location
        ? `<span class="moments-location">📍 ${escapeHtml(p.location)}</span>`
        : '';

    const likesHtml = p.likes > 0
        ? `<div class="moments-likes-row">👍 ${escapeHtml(String(p.likes))}</div>`
        : '';

    const commentsHtml = Array.isArray(p.comments) && p.comments.length
        ? `<div class="moments-comments">${p.comments.map((c) => `
            <div class="moments-comment">
                <span class="moments-comment-name">${escapeHtml(c.authorName || c.from || '?')}</span>
                <span class="moments-comment-text">${escapeHtml(c.content || '')}</span>
            </div>`).join('')}</div>`
        : '';

    const id = escapeHtml(p.id);

    return `
        <div class="moments-card" data-id="${id}">
            <div class="moments-av-col">${avHtml}${avFallback}</div>
            <div class="moments-body">
                <div class="moments-name">${escapeHtml(displayName)}</div>
                <div class="moments-content">${escapeHtml(p.content || '')}</div>
                ${picHtml}
                <div class="moments-meta">
                    <span class="moments-time">${escapeHtml(p.date || '')} ${escapeHtml(p.time || '')}</span>
                    ${locationHtml}
                    <div class="moments-actions">
                        <button class="moments-like-btn${p.likedByUser ? ' liked' : ''}" data-id="${id}" title="点赞">👍</button>
                        <button class="moments-comment-btn" data-id="${id}" title="评论">💬</button>
                    </div>
                </div>
                ${likesHtml}
                ${commentsHtml}
                <div class="moments-input-row" id="moments-input-${id}" style="display:none">
                    <input class="moments-comment-input" type="text" placeholder="评论…" maxlength="100">
                    <button class="moments-comment-send" data-id="${id}">发送</button>
                </div>
            </div>
        </div>`;
}

function renderCompose() {
    return `
        <div class="moments-compose">
            <div class="phone-thread-header">
                <button class="phone-back" data-back-to-feed>‹</button>
                <span class="phone-thread-title">发朋友圈</span>
                <button id="moments-submit-btn" class="moments-submit-btn">发布</button>
            </div>
            <textarea id="moments-compose-body" class="moments-compose-textarea" rows="6" placeholder="这一刻的想法…" maxlength="500"></textarea>
        </div>`;
}

// onRerollPic removed — reroll now handled globally in index.js (matches `.phone-img-reroll-btn`)
export function bindMomentsHandlers(root, { onRefresh, onClear, onCompose, onBackToFeed, onSubmit, onLike, onComment }) {
    root.querySelector('#moments-refresh-btn')?.addEventListener('click', onRefresh);
    root.querySelector('#moments-clear-btn')?.addEventListener('click', onClear);
    root.querySelector('#moments-compose-btn')?.addEventListener('click', onCompose);
    root.querySelector('[data-back-to-feed]')?.addEventListener('click', onBackToFeed);
    root.querySelector('#moments-submit-btn')?.addEventListener('click', () => {
        const content = root.querySelector('#moments-compose-body')?.value.trim() || '';
        if (!content) { toastr.warning('请输入内容'); return; }
        onSubmit({ content });
    });

    root.querySelectorAll('.moments-like-btn').forEach((btn) => {
        btn.addEventListener('click', () => onLike(btn.dataset.id));
    });


    root.querySelectorAll('.moments-comment-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const row = root.querySelector(`#moments-input-${btn.dataset.id}`);
            if (!row) return;
            const open = row.style.display === 'none';
            row.style.display = open ? 'flex' : 'none';
            if (open) row.querySelector('input')?.focus();
        });
    });

    root.querySelectorAll('.moments-comment-send').forEach((btn) => {
        btn.addEventListener('click', () => sendComment(root, btn.dataset.id, onComment));
    });

    root.querySelectorAll('.moments-comment-input').forEach((input) => {
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const id = input.closest('.moments-input-row')?.querySelector('.moments-comment-send')?.dataset.id;
                if (id) sendComment(root, id, onComment);
            }
        });
    });
}

function sendComment(root, id, onComment) {
    const row = root.querySelector(`#moments-input-${id}`);
    const input = row?.querySelector('input');
    const text = input?.value.trim() || '';
    if (!text) return;
    input.value = '';
    row.style.display = 'none';
    onComment(id, text);
}
