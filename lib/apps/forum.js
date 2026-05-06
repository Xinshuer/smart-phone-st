// Forum app — 论坛 BBS-style 列表
import { getChatState } from '../state.js';
import { escapeHtml } from '../util.js';

export function renderForum(chatId) {
    const cs = getChatState(chatId);
    if (!cs.forum.length) {
        return `<div class="phone-empty">论坛暂无帖子</div>`;
    }
    const posts = [...cs.forum].reverse();
    return `
        <div class="phone-forum">
            ${posts.map(renderPost).join('')}
        </div>
    `;
}

function renderPost(p) {
    const pic = p.pic
        ? `<div class="phone-image-slot" data-pic="${escapeHtml(p.pic)}">📷 生成中…</div>`
        : '';
    return `
        <div class="phone-forum-post">
            <div class="phone-forum-meta">
                <span class="phone-forum-board">[${escapeHtml(p.board)}]</span>
                <span class="phone-forum-author">${escapeHtml(p.author)}</span>
                <span class="phone-forum-time">${escapeHtml(p.time || '')}</span>
            </div>
            <div class="phone-forum-title">${escapeHtml(p.title)}</div>
            <div class="phone-forum-content">${escapeHtml(p.content)}</div>
            ${pic}
        </div>
    `;
}
