// Weibo app — 微博 microblog feed
import { getChatState } from '../state.js';
import { escapeHtml } from '../util.js';

export function renderWeibo(chatId) {
    const cs = getChatState(chatId);
    if (!cs.weibo.length) {
        return `<div class="phone-empty">微博暂无动态</div>`;
    }
    const posts = [...cs.weibo].reverse();
    return `
        <div class="phone-weibo">
            ${posts.map(renderPost).join('')}
        </div>
    `;
}

function renderPost(p) {
    const pic = p.pic
        ? `<div class="phone-image-slot" data-pic="${escapeHtml(p.pic)}">📷 生成中…</div>`
        : '';
    return `
        <div class="phone-weibo-post">
            <div class="phone-weibo-header">
                <div class="phone-avatar small">${escapeHtml(p.author.slice(0, 1))}</div>
                <div class="phone-weibo-meta">
                    <div class="phone-weibo-author">${escapeHtml(p.author)}</div>
                    <div class="phone-weibo-time">${escapeHtml(p.time || '')}</div>
                </div>
            </div>
            <div class="phone-weibo-content">${escapeHtml(p.content)}</div>
            ${pic}
            <div class="phone-weibo-actions">
                <span>👍 ${p.likes || 0}</span>
                <span>💬 ${(p.comments || []).length}</span>
            </div>
        </div>
    `;
}
