// 小红书 (XHS) — feed list + post creation form
// Ported from mochi-phone's XHS module.

import { getChatState } from '../state.js';
import { escapeHtml } from '../util.js';

const TAGS = ['日常', '穿搭', '美食', '旅行', '情感', '吐槽', '八卦', '美妆'];

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
        <div class="xhs-toolbar">
            <button id="xhs-compose-btn" class="phone-btn xhs-cta">✏️ 发笔记</button>
            <button id="xhs-refresh-btn" class="phone-btn">🔄 刷新</button>
        </div>
        ${feed.length === 0
            ? '<div class="phone-empty">还没有笔记<br><small>点「发笔记」记录一下，或点「刷新」让网友发新帖</small></div>'
            : `<div class="xhs-feed">${feed.map(renderCard).join('')}</div>`
        }
    `;
}

function renderCard(p) {
    const pic = p.pic
        ? `<div class="phone-image-slot xhs-card-pic" data-pic="${escapeHtml(p.pic)}">📷 生成中…</div>`
        : '';
    const userMark = p.from === 'user' ? '<span class="xhs-mine">我的</span>' : '';
    return `
        <div class="xhs-card" data-postid="${escapeHtml(p.id)}">
            ${pic}
            <div class="xhs-card-body">
                <div class="xhs-card-title">${escapeHtml(p.title || p.body.slice(0, 20))}${userMark}</div>
                <div class="xhs-card-meta">
                    <span class="xhs-tag">#${escapeHtml(p.tag || '日常')}</span>
                    <span class="xhs-likes">❤ ${p.likes || 0}</span>
                    <span class="xhs-comments">💬 ${(p.comments || []).length}</span>
                </div>
                <div class="xhs-card-author">@${escapeHtml(p.user || '匿名')}</div>
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
            <button id="xhs-submit-btn" class="phone-btn xhs-cta-primary">发布</button>
        </div>
    `;
}

function renderDetail(chatId, postId) {
    const cs = getChatState(chatId);
    const p = (cs.xhs || []).find((x) => x.id === postId);
    if (!p) return `<div class="phone-empty">笔记不存在</div>`;
    const pic = p.pic
        ? `<div class="phone-image-slot" data-pic="${escapeHtml(p.pic)}">📷 生成中…</div>`
        : '';
    const comments = (p.comments || []).map((c) => `
        <div class="xhs-comment">
            <span class="xhs-comment-user">${escapeHtml(c.user || c.from || '匿名')}</span>
            <span class="xhs-comment-text">${escapeHtml(c.text || '')}</span>
            <span class="xhs-comment-time">${escapeHtml(c.time || '')}</span>
        </div>
    `).join('');
    return `
        <div class="xhs-detail">
            <div class="phone-thread-header">
                <button class="phone-back" data-back-to-feed>‹</button>
                <span class="phone-thread-title">笔记详情</span>
            </div>
            ${pic}
            <div class="xhs-detail-title">${escapeHtml(p.title || '')}</div>
            <div class="xhs-detail-author">@${escapeHtml(p.user)} · #${escapeHtml(p.tag || '日常')} · ${escapeHtml(p.time || '')}</div>
            <div class="xhs-detail-body">${escapeHtml(p.body)}</div>
            <div class="xhs-detail-meta">❤ ${p.likes || 0} · 💬 ${(p.comments || []).length}</div>
            <div class="xhs-comments">
                <div class="xhs-comments-title">评论 (${(p.comments || []).length})</div>
                ${comments || '<div class="phone-empty-inline">还没人评论</div>'}
            </div>
        </div>
    `;
}

export function bindXHSHandlers(root, { onCompose, onRefresh, onOpenPost, onBackToFeed, onSubmit, onTagSelect }) {
    root.querySelector('#xhs-compose-btn')?.addEventListener('click', onCompose);
    root.querySelector('#xhs-refresh-btn')?.addEventListener('click', onRefresh);
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
