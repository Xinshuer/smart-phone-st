// Messages app — 私聊列表 + 单条会话视图 + 输入框 + 联系人管理子tab
import { getChatState, load as loadState } from '../state.js';
import { escapeHtml, renderImagesGrid } from '../util.js';

// ─── Sub-tab header (rendered when not inside a thread) ───

export function renderMessagesSubTabs(subTab) {
    return `
        <div class="phone-msg-subtabs">
            <button class="phone-msg-subtab${subTab === 'chats' ? ' active' : ''}" data-subtab="chats">💬 聊天</button>
            <button class="phone-msg-subtab${subTab === 'contacts' ? ' active' : ''}" data-subtab="contacts">👤 联系人</button>
        </div>
    `;
}

// ─── Contacts sub-tab ───

export function renderContactsTab() {
    const s = loadState();
    const contacts = s.contacts;
    if (!contacts.length) {
        return `<div class="phone-empty" style="padding:40px 20px">还没有联系人<br><small>前往「设置 → 世界书条目」导入</small></div>`;
    }
    return `
        <div class="phone-contact-list">
            ${contacts.map(renderContactCard).join('')}
        </div>
    `;
}

function renderContactCard(c) {
    const locked = c.anchor?.locked;
    const hasImg = !!c.anchor?.referenceImage;
    const hasContent = !!c.rawContent;
    const refImg = hasImg
        ? `<img class="phone-contact-ref" src="${escapeHtml(c.anchor.referenceImage)}">`
        : `<div class="phone-contact-ref placeholder">无参考图</div>`;
    return `
        <div class="phone-contact-row" data-name="${escapeHtml(c.name)}">
            ${refImg}
            <div class="phone-contact-info">
                <div class="phone-contact-name">
                    ${escapeHtml(c.name)}
                    ${locked ? '<span class="phone-contact-badge">🔒</span>' : ''}
                </div>
                <div class="phone-anchor-row">
                    <input class="phone-contact-anchor-edit phone-input" type="text"
                        data-name="${escapeHtml(c.name)}"
                        value="${escapeHtml(c.anchor?.prompt || '')}"
                        placeholder="外貌: long black hair, asian…"
                    >
                    ${hasContent ? `<button class="phone-btn phone-gen-appearance" data-name="${escapeHtml(c.name)}" title="AI 从世界书提取外貌 tags（需配置手机 API）">✨</button>` : ''}
                </div>
            </div>
            <div class="phone-contact-actions">
                <button class="phone-btn phone-gen-ref" data-name="${escapeHtml(c.name)}">${hasImg ? '换一张' : '生成参考图'}</button>
                ${hasImg ? `<button class="phone-btn phone-lock-ref" data-name="${escapeHtml(c.name)}">${locked ? '解锁' : '✅ 保持'}</button>` : ''}
            </div>
        </div>
    `;
}

// ─── Chat list ───

export function renderMessageList(chatId) {
    const cs = getChatState(chatId);
    const s = loadState();

    // Union of imported contacts and threads with messages
    const seen = new Map();
    for (const c of s.contacts) {
        seen.set(c.name, { name: c.name, msgs: cs.threads[c.name] || [], note: c.note });
    }
    for (const [name, msgs] of Object.entries(cs.threads)) {
        if (!seen.has(name)) seen.set(name, { name, msgs, note: '' });
    }

    if (seen.size === 0) {
        return `<div class="phone-empty">还没有联系人<br><small>从「设置 → 世界书条目」导入联系人</small></div>`;
    }

    const items = [...seen.values()].sort((a, b) => {
        const at = a.msgs.length ? (a.msgs[a.msgs.length - 1].time || '') : '';
        const bt = b.msgs.length ? (b.msgs[b.msgs.length - 1].time || '') : '';
        return bt.localeCompare(at);
    });

    // Build contact refImage lookup for avatars
    const refMap = new Map(s.contacts.filter((c) => c.anchor?.referenceImage).map((c) => [c.name, c.anchor.referenceImage]));

    return `
        <div class="phone-list">
            ${items.map(({ name, msgs, note }) => {
                const last = msgs[msgs.length - 1] || {};
                const preview = msgs.length
                    ? (last.content || '').slice(0, 28)
                    : (note || '点击进入聊天');
                const refImg = refMap.get(name);
                const avatarHtml = refImg
                    ? `<img class="phone-avatar phone-avatar-ref" src="${escapeHtml(refImg)}" alt="${escapeHtml(name.slice(0, 1))}" onerror="this.outerHTML='<div class=\\'phone-avatar\\'>${escapeHtml(name.slice(0, 1))}</div>'">`
                    : `<div class="phone-avatar">${escapeHtml(name.slice(0, 1))}</div>`;
                return `
                    <div class="phone-list-item" data-thread="${escapeHtml(name)}">
                        ${avatarHtml}
                        <div class="phone-list-text">
                            <div class="phone-list-title">${escapeHtml(name)}</div>
                            <div class="phone-list-preview ${msgs.length ? '' : 'empty'}">${escapeHtml(preview)}</div>
                        </div>
                        <div class="phone-list-time">${escapeHtml(last.time || '')}</div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

export function renderThread(chatId, threadName) {
    const cs = getChatState(chatId);
    const s = loadState();
    const contact = s.contacts.find((c) => c.name === threadName);
    const msgs = cs.threads[threadName] || [];
    return `
        <div class="phone-thread-header">
            <button class="phone-back" data-back>‹</button>
            <span class="phone-thread-title">${escapeHtml(threadName)}${contact?.anchor?.locked ? ' 🔒' : ''}</span>
            <button id="phone-reroll-btn" class="phone-reroll-btn" title="重新生成">↩</button>
        </div>
        <div class="phone-thread-body" id="phone-thread-body">
            ${msgs.length
                ? renderBubbles(msgs, contact)
                : `<div class="phone-empty-inline" style="text-align:center;padding:40px 0;">还没有消息<br><small>说点什么吧</small></div>`}
        </div>
        <div class="phone-thread-input">
            <button id="phone-multiselect-btn" class="phone-thread-icon-btn" title="多选转发">🗂</button>
            <button id="phone-cmd-post-btn" class="phone-thread-icon-btn" title="命令角色发帖">📤</button>
            <textarea id="phone-input" rows="1" placeholder="输入消息..."></textarea>
            <button id="phone-send-btn" title="发送 (Enter)">➤</button>
        </div>
    `;
}

function timeToMin(t) {
    const [h, m] = (t || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
}

function renderBubbles(msgs, contact) {
    let lastMin = -Infinity;
    return msgs.map((m, idx) => {
        const min = timeToMin(m.time);
        let divider = '';
        if (min - lastMin >= 5) {
            divider = `<div class="wc-divider">${escapeHtml(m.time || '')}</div>`;
            lastMin = min;
        }
        return divider + renderBubble(m, contact, idx);
    }).join('');
}

function renderBubble(m, contact, idx) {
    const content = renderContent(m);
    const hasPicClass = m.pic ? ' has-pic' : '';
    // Editable bubble: bubbles without a pic can be tapped to reveal a small pencil
    // (handler in index.js toggles .bubble-active; pencil click swaps content for textarea)
    const pencilHtml = m.pic
        ? '' // bubbles with images aren't text-editable inline
        : `<button class="bubble-edit-pencil" title="编辑" data-idx="${idx}">✎</button>`;

    if (m.me) {
        return `
            <div class="wc-row me">
                <div class="phone-bubble me${hasPicClass}" data-msg-idx="${idx}">
                    <div class="phone-bubble-content">${content}</div>
                    <div class="phone-bubble-time">${escapeHtml(m.time || '')}</div>
                    ${pencilHtml}
                </div>
            </div>
        `;
    }
    const initial = escapeHtml((m.from || '?').slice(0, 1));
    const refImg = contact?.anchor?.referenceImage;
    const avHtml = refImg
        ? `<img class="wc-av" src="${escapeHtml(refImg)}" alt="${initial}" onerror="this.outerHTML='<div class=\\'wc-av\\'>${initial}</div>'">`
        : `<div class="wc-av">${initial}</div>`;
    return `
        <div class="wc-row">
            ${avHtml}
            <div class="phone-bubble${hasPicClass}" data-msg-idx="${idx}">
                <div class="phone-bubble-content">${content}</div>
                <div class="phone-bubble-time">${escapeHtml(m.time || '')}</div>
                ${pencilHtml}
            </div>
        </div>
    `;
}

// Unified single-image render via renderImagesGrid → consistent .phone-img-cell selector
// for selection mode + global reroll handler. Source flag 'sms' means no NSFW gate (private chat).
function renderMsgPic(picTag) {
    return renderImagesGrid([picTag], { source: 'sms', allowReroll: true });
}

function renderContent(m) {
    switch (m.type) {
        case 'sticker':
            return `<div class="phone-sticker">${escapeHtml(m.content)}</div>`;
        case 'voice':
            return `<div class="phone-voice">🎤 ${escapeHtml(m.content)}${m.duration ? ` · ${escapeHtml(m.duration)}` : ''}</div>`;
        case 'hongbao':
            return `<div class="phone-hongbao">🧧 ${escapeHtml(m.content)}${m.amount ? ` · ¥${escapeHtml(m.amount)}` : ''}</div>`;
        case 'image':
            return m.pic
                ? renderMsgPic(m.pic)
                : `<div class="phone-image-slot">${escapeHtml(m.content)}</div>`;
        default:
            return `${escapeHtml(m.content)}${m.pic ? renderMsgPic(m.pic) : ''}`;
    }
}
