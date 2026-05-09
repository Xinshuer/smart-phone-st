// Messages app — 私聊列表 + 群聊列表 + 单条/群聊会话视图 + 输入框 + 联系人管理子tab
import { getChatState, load as loadState, getActiveGroups, findGroup, resolveGroupMembers } from '../state.js';
import { escapeHtml, renderImagesGrid, renderGroupSenderLabel, renderGroupAvatar } from '../util.js';

// v0.14.0 helper: 是否为群聊 thread (id 以 'grp_' 开头)
export function isGroupThread(threadId) {
    return typeof threadId === 'string' && threadId.startsWith('grp_');
}

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

    // 单聊条目：来自激活联系人
    const seen = new Map();
    for (const c of s.contacts) {
        seen.set(c.name, { kind: 'contact', name: c.name, msgs: cs.threads[c.name] || [], note: c.note });
    }

    // v0.14.0 群聊条目：未删除 + 至少有 1 个 active 成员
    const groupItems = [];
    const activeGroups = getActiveGroups();
    for (const g of activeGroups) {
        const members = resolveGroupMembers(g);
        const activeCount = members.filter(m => !m.isDeleted).length;
        if (activeCount === 0) continue; // 全员被删的群隐藏
        const msgs = cs.groupThreads?.[g.id] || [];
        groupItems.push({ kind: 'group', id: g.id, name: g.name, members, msgs });
    }

    if (seen.size === 0 && groupItems.length === 0) {
        return `<div class="phone-empty">还没有联系人<br><small>从「设置 → 世界书条目」导入联系人</small><br><br>
            <button class="phone-btn phone-create-group-btn" id="phone-create-group-empty">➕ 新建群聊</button>
        </div>`;
    }

    // 合并联系人 + 群聊列表，按最后消息时间排序
    const allItems = [...seen.values(), ...groupItems].sort((a, b) => {
        const at = a.msgs.length ? (a.msgs[a.msgs.length - 1].time || '') : '';
        const bt = b.msgs.length ? (b.msgs[b.msgs.length - 1].time || '') : '';
        return bt.localeCompare(at);
    });

    // 联系人 refImage 查表
    const refMap = new Map(s.contacts.filter((c) => c.anchor?.referenceImage).map((c) => [c.name, c.anchor.referenceImage]));

    return `
        <div class="phone-list-actions" style="padding:8px 12px;border-bottom:1px solid #eee;">
            <button class="phone-btn phone-create-group-btn" id="phone-create-group-btn">➕ 新建群聊</button>
        </div>
        <div class="phone-list">
            ${allItems.map((item) => {
                if (item.kind === 'group') {
                    const last = item.msgs[item.msgs.length - 1] || {};
                    const senderPrefix = last.from && !last.me ? `${last.from}：` : '';
                    const preview = item.msgs.length
                        ? `${senderPrefix}${(last.content || '').slice(0, 24)}`
                        : '点击进入群聊';
                    const memberCount = item.members.filter(m => !m.isDeleted).length;
                    return `
                        <div class="phone-list-item phone-list-item-group" data-thread-id="${escapeHtml(item.id)}" data-thread-type="group">
                            ${renderGroupAvatar(item.name, 40)}
                            <div class="phone-list-text">
                                <div class="phone-list-title">${escapeHtml(item.name)} <span class="phone-group-count">(${memberCount})</span></div>
                                <div class="phone-list-preview ${item.msgs.length ? '' : 'empty'}">${escapeHtml(preview)}</div>
                            </div>
                            <div class="phone-list-time">${escapeHtml(last.time || '')}</div>
                        </div>
                    `;
                }
                // 单聊
                const { name, msgs, note } = item;
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

// v0.14.0 群聊会话视图渲染
export function renderGroupThread(chatId, groupId) {
    const cs = getChatState(chatId);
    const group = findGroup(groupId);
    if (!group) return `<div class="phone-empty">群聊不存在</div>`;
    const members = resolveGroupMembers(group);
    const msgs = cs.groupThreads?.[groupId] || [];
    return `
        <div class="phone-thread-header">
            <button class="phone-back" data-back>‹</button>
            <span class="phone-thread-title">${escapeHtml(group.name)} <span class="phone-group-count">(${members.filter(m => !m.isDeleted).length})</span></span>
            <button id="phone-group-settings-btn" class="phone-thread-icon-btn" title="群设置" data-group-id="${escapeHtml(groupId)}">⚙</button>
            <button id="phone-reroll-btn" class="phone-reroll-btn" title="重新生成">↩</button>
        </div>
        <div class="phone-thread-body" id="phone-thread-body">
            ${msgs.length
                ? renderGroupBubbles(msgs, members)
                : `<div class="phone-empty-inline" style="text-align:center;padding:40px 0;">还没有群消息<br><small>说点什么吧</small></div>`}
        </div>
        <div class="phone-thread-input">
            <button id="phone-multiselect-btn" class="phone-thread-icon-btn" title="多选转发">🗂</button>
            <button id="phone-group-photo-btn" class="phone-thread-icon-btn" title="群聊生图" data-group-id="${escapeHtml(groupId)}">📷</button>
            <button id="phone-cmd-post-btn" class="phone-thread-icon-btn" title="命令角色发帖">📤</button>
            <textarea id="phone-input" rows="1" placeholder="群聊里说点什么..."></textarea>
            <button id="phone-send-btn" title="发送 (Enter)">➤</button>
        </div>
    `;
}

// 群聊气泡渲染：每条 NPC 气泡顶上显示 sender label
function renderGroupBubbles(msgs, members) {
    let lastMin = -Infinity;
    // 用 nameSnapshot 索引成员状态（已删除/可发送等）
    const memberByName = new Map(members.map(m => [m.nameSnapshot, m]));
    return msgs.map((m, idx) => {
        const min = timeToMin(m.time);
        let divider = '';
        if (min - lastMin >= 5) {
            divider = `<div class="wc-divider">${escapeHtml(m.time || '')}</div>`;
            lastMin = min;
        }
        return divider + renderGroupBubble(m, idx, memberByName);
    }).join('');
}

function renderGroupBubble(m, idx, memberByName) {
    const content = renderContent(m);
    const hasPicClass = m.pic ? ' has-pic' : '';
    if (m.me) {
        // 用户消息
        const pencilHtml = m.pic ? '' : `<button class="bubble-edit-pencil" title="编辑" data-idx="${idx}">✎</button>`;
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
    // NPC 群消息：每条都显示 sender label（用户决策）
    const memberInfo = memberByName.get(m.from);
    const isDeleted = !!memberInfo?.isDeleted;
    const refImg = memberInfo?.contact?.anchor?.referenceImage;
    const initial = escapeHtml((m.from || '?').slice(0, 1));
    const avHtml = refImg
        ? `<img class="wc-av" src="${escapeHtml(refImg)}" alt="${initial}" onerror="this.outerHTML='<div class=\\'wc-av\\'>${initial}</div>'">`
        : `<div class="wc-av">${initial}</div>`;
    const senderLabel = renderGroupSenderLabel(m.from || '?', isDeleted);
    const deletedClass = isDeleted ? ' wc-row-deleted' : '';
    const pencilHtml = m.pic ? '' : `<button class="bubble-edit-pencil" title="编辑" data-idx="${idx}">✎</button>`;
    return `
        <div class="wc-row${deletedClass}">
            ${avHtml}
            <div class="wc-msg-col">
                ${senderLabel}
                <div class="phone-bubble${hasPicClass}" data-msg-idx="${idx}">
                    <div class="phone-bubble-content">${content}</div>
                    <div class="phone-bubble-time">${escapeHtml(m.time || '')}</div>
                    ${pencilHtml}
                </div>
            </div>
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

// v0.14.0 群聊生图 slot：传 SUBJECTS 数组让下游走多角色 anchor 路径
// subjects.length > 1 时 dataset.subjects 含逗号分隔列表，触发多角色 prompt 拼接
function renderGroupMsgPic(picTag, subjects = []) {
    return renderImagesGrid([picTag], {
        source: 'group',
        allowReroll: true,
        subjects: Array.isArray(subjects) ? subjects.join(',') : '',
    });
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
            // v0.14.0 群消息含 subjects 时走多角色 pic slot（含 dataset.subjects）
            if (m.pic) {
                if (Array.isArray(m.subjects) && m.subjects.length > 1) {
                    return `${escapeHtml(m.content)}${renderGroupMsgPic(m.pic, m.subjects)}`;
                }
                return `${escapeHtml(m.content)}${renderMsgPic(m.pic)}`;
            }
            return escapeHtml(m.content);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// v0.14.0 群聊 modal 渲染器（创建群 / 群聊生图模式选择 / 成员选择 / 进度反馈）
// ─────────────────────────────────────────────────────────────────────────

// 创建群 modal — 强制群名 + ≥2 成员
export function renderCreateGroupModal() {
    const s = loadState();
    const contacts = s.contacts || [];
    if (contacts.length < 2) {
        return `<div class="phone-modal-bg" id="phone-create-group-modal">
            <div class="phone-modal">
                <div class="phone-modal-hd">无法创建群聊</div>
                <div class="phone-modal-body">
                    <p style="padding:16px;color:#666;">群聊至少需要 2 个联系人，请先到「设置 → 联系人」导入更多。</p>
                </div>
                <div class="phone-modal-ft">
                    <button class="phone-btn" data-modal-cancel>知道了</button>
                </div>
            </div>
        </div>`;
    }
    const memberItems = contacts.map(c => {
        const hasAnchor = !!(c.anchor?.prompt);
        const anchorBadge = hasAnchor
            ? '<span class="phone-anchor-ok">✅ 有外貌</span>'
            : '<span class="phone-anchor-warn">⚠ 无外貌</span>';
        const refImg = c.anchor?.referenceImage;
        const av = refImg
            ? `<img class="phone-pick-av" src="${escapeHtml(refImg)}">`
            : `<div class="phone-pick-av">${escapeHtml(c.name.slice(0, 1))}</div>`;
        return `<label class="phone-member-pick${hasAnchor ? '' : ' no-anchor'}" data-cid="${escapeHtml(c.id)}">
            <input type="checkbox" class="phone-member-checkbox" data-cid="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name)}" data-has-anchor="${hasAnchor ? '1' : '0'}">
            ${av}
            <span class="phone-pick-name">${escapeHtml(c.name)}</span>
            ${anchorBadge}
        </label>`;
    }).join('');
    return `<div class="phone-modal-bg" id="phone-create-group-modal">
        <div class="phone-modal">
            <div class="phone-modal-hd">创建群聊</div>
            <div class="phone-modal-body">
                <div class="phone-form-row">
                    <label class="phone-form-label">群名 <span style="color:#e74c3c;">*</span></label>
                    <input type="text" id="phone-create-group-name" class="phone-input" placeholder="必填，最多 20 字" maxlength="20">
                </div>
                <div class="phone-form-row">
                    <label class="phone-form-label">选择成员（≥2 人）</label>
                    <div class="phone-member-list" id="phone-create-group-members">${memberItems}</div>
                </div>
                <p class="phone-hint" style="font-size:11px;color:#888;margin-top:8px;">
                    💡 ⚠ 无外貌成员仍可加入群，但模式 ② 全员合影 / 模式 ⑤ 分组合照需要每个参与者都有外貌锚点
                </p>
            </div>
            <div class="phone-modal-ft">
                <button class="phone-btn" data-modal-cancel>取消</button>
                <button class="phone-btn phone-btn-primary" id="phone-create-group-confirm" disabled>创建 (0)</button>
            </div>
        </div>
    </div>`;
}

// 群聊生图模式选择 modal
export function renderGroupPhotoModeModal(groupId) {
    return `<div class="phone-modal-bg" id="phone-group-photo-modal">
        <div class="phone-modal">
            <div class="phone-modal-hd">群聊生图</div>
            <div class="phone-modal-body">
                <div class="phone-mode-list">
                    <button class="phone-mode-item" data-mode="selfie" data-group-id="${escapeHtml(groupId)}">
                        <div class="phone-mode-title">① 单人自拍</div>
                        <div class="phone-mode-desc">选 1 人 → 该成员在群里发自拍 + 其他人调侃</div>
                    </button>
                    <button class="phone-mode-item" data-mode="group_photo" data-group-id="${escapeHtml(groupId)}">
                        <div class="phone-mode-title">② 全员合影 (1-3 人) ★</div>
                        <div class="phone-mode-desc">全员同框一张图（≥4 人改用 ⑤）</div>
                    </button>
                    <button class="phone-mode-item" data-mode="paired_group_photo" data-group-id="${escapeHtml(groupId)}">
                        <div class="phone-mode-title">⑤ 分组合照 (4-6 人)</div>
                        <div class="phone-mode-desc">自动 2 人一组生 ⌈N/2⌉ 张图</div>
                    </button>
                    <button class="phone-mode-item" data-mode="one_post_others_comment" data-group-id="${escapeHtml(groupId)}">
                        <div class="phone-mode-title">③ 一人发图，其他人评价</div>
                        <div class="phone-mode-desc">1 人发图 + N-1 人文字评论</div>
                    </button>
                    <button class="phone-mode-item" data-mode="each_own_scene" data-group-id="${escapeHtml(groupId)}">
                        <div class="phone-mode-title">④ 各自发不同场景</div>
                        <div class="phone-mode-desc">每人一张当前所在场景图</div>
                    </button>
                </div>
            </div>
            <div class="phone-modal-ft">
                <button class="phone-btn" data-modal-cancel>取消</button>
            </div>
        </div>
    </div>`;
}

// 模式选定后 — 成员/场景选择 modal
// mode 决定限制：
//   selfie: 选 1
//   group_photo: 选 1-3 + 必须都有 anchor
//   paired_group_photo: 选 4-6 + 必须都有 anchor
//   one_post_others_comment: 第一个 = 发图者（必须有 anchor），其他人 = 评论者
//   each_own_scene: 选 ≥1 + 必须都有 anchor
export function renderGroupPhotoMemberPickModal({ groupId, mode }) {
    const group = findGroup(groupId);
    if (!group) return '';
    const members = resolveGroupMembers(group).filter(m => !m.isDeleted);

    const requireAnchor = mode === 'group_photo' || mode === 'paired_group_photo' || mode === 'each_own_scene' || mode === 'one_post_others_comment';
    const limitsMap = {
        selfie: { min: 1, max: 1, label: '选 1 人发自拍' },
        group_photo: { min: 1, max: 3, label: '选 1-3 人合影（每人需有外貌锚点）' },
        paired_group_photo: { min: 4, max: 6, label: '选 4-6 人分组合照（每人需有外貌锚点）' },
        one_post_others_comment: { min: 2, max: 8, label: '第 1 个勾选 = 发图者（需有外貌），后续 = 评论者' },
        each_own_scene: { min: 1, max: 6, label: '选要发图的成员（每人需有外貌锚点）' },
    };
    const limit = limitsMap[mode] || limitsMap.selfie;
    const titleMap = {
        selfie: '① 单人自拍',
        group_photo: '② 全员合影',
        paired_group_photo: '⑤ 分组合照',
        one_post_others_comment: '③ 一发多评',
        each_own_scene: '④ 各自发不同场景',
    };

    const memberItems = members.map(m => {
        const hasAnchor = m.hasAnchor;
        const disabled = requireAnchor && !hasAnchor;
        const refImg = m.contact?.anchor?.referenceImage;
        const av = refImg
            ? `<img class="phone-pick-av" src="${escapeHtml(refImg)}">`
            : `<div class="phone-pick-av">${escapeHtml(m.nameSnapshot.slice(0, 1))}</div>`;
        const anchorBadge = hasAnchor
            ? '<span class="phone-anchor-ok">✅ 有外貌</span>'
            : `<span class="phone-anchor-warn">⚠ 无外貌</span>`;
        const goLink = !hasAnchor && m.contact
            ? `<a class="phone-anchor-go-link" href="#" data-go-anchor="${escapeHtml(m.contact.name)}">[去补 ✨]</a>`
            : '';
        return `<label class="phone-member-pick${hasAnchor ? '' : ' no-anchor'}${disabled ? ' disabled' : ''}" data-cid="${escapeHtml(m.contactId)}">
            <input type="checkbox" class="phone-photo-member-checkbox" data-cid="${escapeHtml(m.contactId)}" data-name="${escapeHtml(m.nameSnapshot)}" data-has-anchor="${hasAnchor ? '1' : '0'}" ${disabled ? 'disabled' : ''}>
            ${av}
            <span class="phone-pick-name">${escapeHtml(m.nameSnapshot)}</span>
            ${anchorBadge}
            ${goLink}
        </label>`;
    }).join('');

    return `<div class="phone-modal-bg" id="phone-group-photo-pick-modal" data-mode="${escapeHtml(mode)}" data-group-id="${escapeHtml(groupId)}">
        <div class="phone-modal">
            <div class="phone-modal-hd">${titleMap[mode] || '群聊生图'}</div>
            <div class="phone-modal-body">
                <div class="phone-form-row">
                    <label class="phone-form-label">${limit.label}</label>
                    <div class="phone-member-list">${memberItems}</div>
                </div>
                <div class="phone-form-row">
                    <label class="phone-form-label">场景描述（可选）</label>
                    <input type="text" id="phone-group-photo-scene" class="phone-input" placeholder="例：在咖啡馆 / 海边玩水 / 蹦迪 / 健身房">
                </div>
            </div>
            <div class="phone-modal-ft">
                <button class="phone-btn" data-modal-cancel>取消</button>
                <button class="phone-btn phone-btn-primary" id="phone-group-photo-confirm" disabled data-min="${limit.min}" data-max="${limit.max}">生成 (0/${limit.max})</button>
            </div>
        </div>
    </div>`;
}
