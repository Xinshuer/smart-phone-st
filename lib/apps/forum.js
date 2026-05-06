// 论坛 — 百度贴吧风格：帖子列表 + 详情页 + 发帖
import { getChatState } from '../state.js';
import { escapeHtml } from '../util.js';

const BOARDS = ['情感吧', '搞笑吧', '八卦吧', '美食吧', '旅游吧', '日常吧', '吐槽吧', '游戏吧'];

let forumView = 'feed'; // 'feed' | 'detail' | 'compose'
let forumDetailId = null;
let forumComposeBoard = '日常吧';

export function getForumView() { return forumView; }
export function getForumDetailId() { return forumDetailId; }
export function setForumView(v, id = null) { forumView = v; if (id !== null) forumDetailId = id; }

export function renderForum(chatId) {
    if (forumView === 'compose') return renderCompose();
    if (forumView === 'detail') return renderDetail(chatId, forumDetailId);
    return renderFeed(chatId);
}

function renderFeed(chatId) {
    const cs = getChatState(chatId);
    const posts = (cs.forum || []).slice().reverse();
    return `
        <div class="tb-wrap">
            <div class="tb-nav">
                <span class="tb-nav-title">📋 综合贴吧</span>
                <button id="tb-refresh-btn" class="tb-nav-icon" title="刷新">🔄</button>
                <button id="tb-clear-btn" class="tb-nav-icon" title="清空并重生成">🗑️</button>
                <button id="tb-compose-btn" class="tb-nav-compose">✏️ 发帖</button>
            </div>
            ${posts.length === 0
                ? '<div class="phone-empty">还没有帖子<br><small>点「✏️ 发帖」或「🔄」让网友发帖</small></div>'
                : `<div class="tb-feed">${posts.map(renderPostCard).join('')}</div>`}
        </div>
    `;
}

function renderPostCard(p) {
    const replyCount = Array.isArray(p.replies) ? p.replies.length : 0;
    const preview = escapeHtml((p.content || '').slice(0, 60));
    const mineBadge = p.from === 'user' ? '<span class="tb-mine-badge">我的</span>' : '';
    return `
        <div class="tb-card" data-postid="${escapeHtml(p.id)}">
            <div class="tb-card-title">${escapeHtml(p.title || '')}${mineBadge}</div>
            <div class="tb-card-preview">${preview}</div>
            <div class="tb-card-footer">
                <span class="tb-board-tag">${escapeHtml(p.board || '日常吧')}</span>
                <span class="tb-author">${escapeHtml(p.author || '匿名')}</span>
                <span class="tb-stat">💬 ${replyCount}</span>
                <span class="tb-stat">👍 ${p.likes || 0}</span>
                <span class="tb-time">${escapeHtml(p.time || '')}</span>
            </div>
        </div>
    `;
}

function renderDetail(chatId, postId) {
    const cs = getChatState(chatId);
    const p = (cs.forum || []).find((x) => x.id === postId);
    if (!p) return `<div class="phone-empty">帖子不存在</div>`;

    const initial = escapeHtml((p.author || '?').slice(0, 1));
    const replies = Array.isArray(p.replies) ? p.replies : [];
    const picHtml = p.pic
        ? `<div class="phone-image-slot" data-pic="${escapeHtml(p.pic)}" data-hint="${escapeHtml(p.author || '')}" data-context="${escapeHtml((p.title || '') + ' ' + (p.content || ''))}">📷 生成中…</div>
           <div class="forum-reroll-row">
               <button class="forum-reroll-pic-btn" data-pic="${escapeHtml(p.pic)}" title="重新生成图片">🔄 重新生成</button>
           </div>`
        : '';

    return `
        <div class="tb-detail">
            <div class="tb-detail-topbar">
                <button class="phone-back" data-back-to-feed>‹</button>
                <span class="tb-detail-title">${escapeHtml(p.title || '')}</span>
            </div>
            <div class="tb-detail-body">
                <div class="tb-floor tb-floor-op">
                    <div class="tb-floor-av">${initial}</div>
                    <div class="tb-floor-body">
                        <div class="tb-floor-author">${escapeHtml(p.author || '匿名')}</div>
                        <div class="tb-floor-content">${escapeHtml(p.content || '')}</div>
                        ${picHtml}
                        <div class="tb-floor-meta">
                            <span class="tb-board-tag">${escapeHtml(p.board || '日常吧')}</span>
                            <span class="tb-floor-time">${escapeHtml(p.time || '')}${p.date ? ' · ' + escapeHtml(p.date) : ''}</span>
                            <span>👍 ${p.likes || 0}</span>
                        </div>
                    </div>
                </div>
                <div class="tb-replies">
                    ${replies.length
                        ? replies.map((r, i) => renderReply(r, i + 2)).join('')
                        : '<div class="phone-empty-inline" style="padding:20px;text-align:center;color:#aaa;">暂无回复</div>'}
                </div>
            </div>
            <div class="phone-thread-input">
                <textarea id="tb-reply-input" rows="1" placeholder="回复楼主..."></textarea>
                <button id="tb-reply-btn" title="回复">➤</button>
            </div>
        </div>
    `;
}

function renderReply(r, floor) {
    const initial = escapeHtml((r.author || '?').slice(0, 1));
    return `
        <div class="tb-floor">
            <div class="tb-floor-side">
                <div class="tb-floor-num">${floor}楼</div>
                <div class="tb-floor-av">${initial}</div>
            </div>
            <div class="tb-floor-body">
                <div class="tb-floor-author">${escapeHtml(r.author || '匿名')}</div>
                <div class="tb-floor-content">${escapeHtml(r.content || '')}</div>
                <div class="tb-floor-time">${escapeHtml(r.time || '')}</div>
            </div>
        </div>
    `;
}

function renderCompose() {
    return `
        <div class="tb-compose">
            <div class="phone-thread-header">
                <button class="phone-back" data-back-to-feed>‹</button>
                <span class="phone-thread-title">发新帖</span>
                <span style="width:40px;"></span>
            </div>
            <div class="tb-board-select-row">
                ${BOARDS.map((b) => `<button class="tb-board-btn${b === forumComposeBoard ? ' active' : ''}" data-board="${escapeHtml(b)}">${escapeHtml(b)}</button>`).join('')}
            </div>
            <input id="tb-post-title" class="phone-input tb-compose-input" type="text" placeholder="标题（必填）" maxlength="40">
            <textarea id="tb-post-body" class="phone-input tb-compose-input" rows="7" placeholder="正文..." maxlength="500" style="font-family:inherit;"></textarea>
            <button id="tb-submit-btn" class="tb-submit-btn">发 布</button>
        </div>
    `;
}

export function bindForumHandlers(root, { onRefresh, onClear, onOpenPost, onBackToFeed, onCompose, onSubmit, onReply, onRerollPic }) {
    root.querySelector('#tb-refresh-btn')?.addEventListener('click', onRefresh);
    root.querySelector('#tb-clear-btn')?.addEventListener('click', onClear);
    root.querySelector('#tb-compose-btn')?.addEventListener('click', onCompose);
    root.querySelectorAll('.tb-card').forEach((el) => {
        el.addEventListener('click', () => onOpenPost(el.dataset.postid));
    });
    root.querySelector('[data-back-to-feed]')?.addEventListener('click', onBackToFeed);
    root.querySelector('#tb-submit-btn')?.addEventListener('click', () => {
        const title = root.querySelector('#tb-post-title')?.value.trim() || '';
        const content = root.querySelector('#tb-post-body')?.value.trim() || '';
        if (!title) { toastr.warning('请输入标题'); return; }
        if (!content) { toastr.warning('请输入正文'); return; }
        onSubmit({ title, content, board: forumComposeBoard });
    });
    root.querySelectorAll('.tb-board-btn').forEach((b) => {
        b.addEventListener('click', () => {
            forumComposeBoard = b.dataset.board;
            root.querySelectorAll('.tb-board-btn').forEach((x) => x.classList.toggle('active', x === b));
        });
    });
    const replyInput = root.querySelector('#tb-reply-input');
    const replyBtn = root.querySelector('#tb-reply-btn');
    if (replyInput && replyBtn) {
        const send = () => {
            const text = replyInput.value.trim();
            if (!text) return;
            replyInput.value = '';
            onReply(text);
        };
        replyBtn.addEventListener('click', send);
        replyInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
        });
    }
    root.querySelector('.forum-reroll-pic-btn')?.addEventListener('click', (e) => {
        const picTag = e.currentTarget.dataset.pic;
        if (picTag) onRerollPic?.(picTag);
    });
    const detailBody = root.querySelector('.tb-detail-body');
    if (detailBody) detailBody.scrollTop = detailBody.scrollHeight;
}
