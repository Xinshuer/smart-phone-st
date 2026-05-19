// smart-phone: SillyTavern phone extension (mochi-phone-style messaging + XHS).
//
// Architecture:
//   • Main chat AI: handles SMS/MOMENTS/GMSG via injected protocol prompt + <PHONE>
//     block in its replies. User-initiated SMS uses <Request:> OOC wrap (mochi).
//   • Separate phone API (DeepSeek/etc): handles XHS stranger comments + ambient
//     NPC content (forum refresh, fresh XHS feed).
//
// Tabs: 消息 / 论坛 / 小红书 / 设置

import { extension_settings, getContext } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
} from '../../../../script.js';

import * as Protocol from './lib/protocol.js';
import * as State from './lib/state.js';
import * as WB from './lib/worldbook.js';
import { generatePicPromptForContext, generatePicPromptViaPhoneApi } from './lib/pic-prompt-gen.js';
import { analyzeUserIntent, inferTarget, prefirePics } from './lib/pre-fire.js';
import { testPhoneApi, fetchProviderModels, callPhoneApi } from './lib/phone-api.js';
import { generateStrangerComments, generateFreshFeed } from './lib/xhs-api.js';
import { generateFreshPosts, generatePostReplies } from './lib/forum-api.js';
import { renderMessageList, renderThread, renderMessagesSubTabs, renderContactsTab, renderGroupThread, renderCreateGroupModal, renderGroupPhotoModeModal, renderGroupPhotoMemberPickModal, isGroupThread } from './lib/apps/messages.js';
import { renderForum, bindForumHandlers, setForumView as forumSetView, getForumDetailId, BOARDS as FORUM_BOARDS } from './lib/apps/forum.js';
import { renderMoments, bindMomentsHandlers, setMomentsView as momentsSetView } from './lib/apps/moments.js';
import { generateContactMoments, generateMomentReplies } from './lib/moments-api.js';
import { renderXHS, bindXHSHandlers, getActiveView as xhsView, setView as xhsSetView, TAGS as XHS_TAGS } from './lib/apps/xhs.js';
import { renderSettings, bindSettingsHandlers, entryToContact, partitionContacts, setShowAllContactsFlag } from './lib/apps/settings.js';
import { getActiveBookNames } from './lib/worldbook.js';
import { escapeHtml } from './lib/util.js';

const EXT = 'smart-phone';

const IS_TOUCH_DEVICE = ('ontouchstart' in window) || /Android|iPhone|iPod/i.test(navigator.userAgent);

let phoneRoot = null;
let currentApp = 'messages';
let currentThread = null;
let currentMessagesSubTab = 'chats'; // 'chats' | 'contacts'

// Survives tab switches and re-renders within the same page session.
// Key = full picTag string (unique per prompt), value = resolved imageUrl.
// Prevents re-generation when switching tabs or when new messages arrive.
const picUrlCache = new Map();

// ─────────────────────────────────────────────────────────────────────────
// Selection mode (Phase B) — long-press + 🗂 button to multi-select chat images
// for forward (Phase C) or command-character (Phase D).
//
// Scope rule: only chat thread images (inside #phone-thread-body) can be selected.
// Selection clears on thread change or app tab change.
// ─────────────────────────────────────────────────────────────────────────
let selectionMode = false;
const selectedImageUrls = new Set();   // ordered insertion = ordered forward
let selectionScopeThread = null;        // contact name when selection started

// Long-press tracking
let lpTimer = null;
let lpStartXY = null;
let lpCellWhileTimer = null;
let suppressNextClick = false; // set after long-press fires; eats the trailing click that would otherwise undo the selection
const LP_DELAY_MS = 500;
const LP_MOVE_CANCEL_PX = 10;

// ─────────────────────────────────────────────────────────────────────────
// Pending command-character post (Phase D)
// Set when user submits the command modal; consumed in onMessageReceived when AI returns.
// Cleared on thread change. Module-level — survives tab switches but not page reloads.
// ─────────────────────────────────────────────────────────────────────────
let pendingPostCommand = null; // { platform, targetName, time, imageUrls: [] }

// ─────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────

$(async function () {
    State.load();
    injectFloatingButton();
    injectMenuButton();
    injectPhoneShell();
    bindEvents();
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', fixMobileShellPos);
    }
    console.log(`[${EXT}] loaded`);
});

function injectFloatingButton() {
    if (document.getElementById('smart-phone-float-btn')) return;
    const btn = document.createElement('div');
    btn.id = 'smart-phone-float-btn';
    btn.title = 'Smart Phone (拖动可移动)';
    btn.textContent = '📱';
    btn.setAttribute('style', [
        'position: fixed !important',
        'right: 16px !important',
        'bottom: auto !important',
        'top: 0px !important',
        'width: 56px !important',
        'height: 56px !important',
        'border-radius: 50% !important',
        'background: linear-gradient(135deg, #93c5fd, #60a5fa) !important',
        'color: white !important',
        'display: flex !important',
        'align-items: center !important',
        'justify-content: center !important',
        'font-size: 28px !important',
        'cursor: pointer !important',
        'z-index: 2147483646 !important',
        'box-shadow: 0 4px 16px rgba(0,0,0,0.35) !important',
        'user-select: none !important',
        '-webkit-tap-highlight-color: transparent !important',
        'touch-action: none !important',
        'pointer-events: auto !important',
    ].join('; '));
    (document.documentElement || document.body).appendChild(btn);

    // ST's <html> has CSS transform, making it the containing block for
    // position:fixed. This collapses the html height to 0, so bottom:Xpx
    // places the button off-screen. Use top=window.innerHeight-offset instead.
    function applyFabPos() {
        const h = Math.max(btn.offsetHeight, 56);
        btn.style.setProperty('top',        (window.innerHeight - 180 - h) + 'px', 'important');
        btn.style.setProperty('bottom',     'auto',    'important');
        btn.style.setProperty('right',      '16px',    'important');
        btn.style.setProperty('left',       'auto',    'important');
        btn.style.setProperty('display',    'flex',    'important');
        btn.style.setProperty('visibility', 'visible', 'important');
    }
    applyFabPos();
    setTimeout(applyFabPos, 200);
    setTimeout(applyFabPos, 800);

    btn.addEventListener('click', () => {
        if (btn.dataset.dragged === '1') { btn.dataset.dragged = ''; return; }
        togglePhone();
    });
    makeButtonDraggable(btn);
    console.log(`[${EXT}] floating button injected → ${btn.parentNode?.tagName}`);
}

function makeButtonDraggable(btn) {
    let dragging = false, moved = false, offX = 0, offY = 0;

    const start = (clientX, clientY) => {
        dragging = true; moved = false;
        const r = btn.getBoundingClientRect();
        offX = clientX - r.left; offY = clientY - r.top;
    };
    const move = (clientX, clientY) => {
        if (!dragging) return;
        moved = true;
        // setProperty with 'important' so we override the inline !important
        // baseline styles set in injectFloatingButton
        btn.style.setProperty('left', (clientX - offX) + 'px', 'important');
        btn.style.setProperty('top', (clientY - offY) + 'px', 'important');
        btn.style.setProperty('right', 'auto', 'important');
        btn.style.setProperty('bottom', 'auto', 'important');
    };
    const end = () => {
        if (dragging && moved) btn.dataset.dragged = '1';
        dragging = false;
    };

    // Mouse
    btn.addEventListener('mousedown', (e) => { start(e.clientX, e.clientY); e.preventDefault(); });
    document.addEventListener('mousemove', (e) => move(e.clientX, e.clientY));
    document.addEventListener('mouseup', end);

    // Touch
    btn.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        start(t.clientX, t.clientY);
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        const t = e.touches[0];
        move(t.clientX, t.clientY);
        e.preventDefault();
    }, { passive: false });
    document.addEventListener('touchend', end);
    document.addEventListener('touchcancel', end);
}

function injectMenuButton() {
    if ($('#smart-phone-menu-btn').length) return;
    $('#extensionsMenu').append(`
        <div id="smart-phone-menu-btn" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-mobile-screen"></div>
            <span>Smart Phone</span>
        </div>
    `);
    $('#smart-phone-menu-btn').on('click', togglePhone);
}

function injectPhoneShell() {
    if ($('#smart-phone-shell').length) return;
    $('body').append(`
        <div id="smart-phone-shell" class="smart-phone-hidden">
            <div class="smart-phone-frame">
                <div class="smart-phone-statusbar">
                    <span class="smart-phone-time"></span>
                    <span class="smart-phone-icons">●●● 📶 🔋</span>
                </div>
                <div class="smart-phone-screen" id="smart-phone-screen"></div>
                <div id="phone-selection-toolbar" class="phone-sel-toolbar" style="display:none">
                    <button id="phone-sel-cancel" class="phone-sel-cancel" title="退出多选">✕</button>
                    <span id="phone-sel-count" class="phone-sel-count">0 张已选</span>
                    <div class="phone-sel-actions">
                        <button class="phone-sel-action" data-target="moments" disabled>📤 朋友圈</button>
                        <button class="phone-sel-action" data-target="forum" disabled>📤 论坛</button>
                        <button class="phone-sel-action" data-target="xhs" disabled>📤 小红书</button>
                    </div>
                </div>
                <div class="smart-phone-tabbar">
                    <button class="smart-phone-tab" data-app="messages">💬<small>消息</small></button>
                    <button class="smart-phone-tab" data-app="moments">👥<small>朋友圈</small></button>
                    <button class="smart-phone-tab" data-app="forum">📋<small>论坛</small></button>
                    <button class="smart-phone-tab" data-app="xhs">📕<small>小红书</small></button>
                    <button class="smart-phone-tab" data-app="settings">⚙️<small>设置</small></button>
                </div>
                <button class="smart-phone-close" title="收起">×</button>
            </div>
        </div>
    `);
    phoneRoot = document.getElementById('smart-phone-shell');
    bindGlobalEventDelegation(); // Phase B — long-press / click / selection toolbar

    $('.smart-phone-tab').on('click', (e) => {
        currentApp = e.currentTarget.dataset.app;
        // Tab change clears selection mode (selection is scoped to a chat thread)
        if (selectionMode) exitSelectionMode();
        currentThread = null;
        currentMessagesSubTab = 'chats';
        xhsSetView('feed');
        forumSetView('feed');
        momentsSetView('feed');
        rerender();
    });
    $('.smart-phone-close').on('click', () => phoneRoot.classList.add('smart-phone-hidden'));

    makeFrameDraggable(phoneRoot.querySelector('.smart-phone-frame'), phoneRoot);

    rerender();
    setInterval(updateStatusBar, 30_000);
    updateStatusBar();
}

function updateStatusBar() {
    const t = new Date();
    $('.smart-phone-time').text(`${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`);
}

// Fix: ST's <html> transform collapses the containing block height to 0.
// position:fixed shell with bottom:Xpx becomes zero-height on mobile.
// Override via JS using window.visualViewport for correct dimensions.
function fixMobileShellPos() {
    if (!IS_TOUCH_DEVICE || !phoneRoot || phoneRoot.classList.contains('smart-phone-hidden')) return;
    const m = 8;
    const vw = window.visualViewport ? window.visualViewport.width  : window.innerWidth;
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    phoneRoot.style.setProperty('position', 'fixed',             'important');
    phoneRoot.style.setProperty('top',      m + 'px',            'important');
    phoneRoot.style.setProperty('left',     m + 'px',            'important');
    phoneRoot.style.setProperty('right',    'auto',              'important');
    phoneRoot.style.setProperty('bottom',   'auto',              'important');
    phoneRoot.style.setProperty('width',    (vw - m * 2) + 'px', 'important');
    phoneRoot.style.setProperty('height',   (vh - m * 2) + 'px', 'important');
}

function togglePhone() {
    if (!phoneRoot) return;
    phoneRoot.classList.toggle('smart-phone-hidden');
    if (!phoneRoot.classList.contains('smart-phone-hidden')) {
        fixMobileShellPos();
        setTimeout(fixMobileShellPos, 200);
    }
}

function makeFrameDraggable(handle, target) {
    let dragging = false, offX = 0, offY = 0;

    function isInteractive(el) {
        return ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL'].includes(el.tagName)
            || !!el.closest('#smart-phone-screen')
            // v0.14.7 关键修复：modal 内的 touch 必须 OPT OUT 手机壳拖拽逻辑
            // 之前 v0.14.4 把 modal 插入到 .smart-phone-frame（在 screen 外），
            // 导致 modal 内 touchmove 被 makeFrameDraggable 的 preventDefault 抢占 →
            // 内容 scroll 失效 + 整个手机壳被拖动。closest 检查 modal-bg 后修复。
            || !!el.closest('.phone-modal-bg');
    }
    function startDrag(clientX, clientY, el) {
        if (isInteractive(el)) return false;
        dragging = true;
        const r = target.getBoundingClientRect();
        offX = clientX - r.left; offY = clientY - r.top;
        return true;
    }
    function moveDrag(clientX, clientY) {
        if (!dragging) return;
        const nL = Math.max(0, Math.min(window.innerWidth  - target.offsetWidth,  clientX - offX));
        const nT = Math.max(0, Math.min(window.innerHeight - target.offsetHeight, clientY - offY));
        target.style.left = nL + 'px'; target.style.top = nT + 'px';
        target.style.right = 'auto';   target.style.bottom = 'auto';
    }

    // Mouse
    handle.addEventListener('mousedown', (e) => {
        if (!startDrag(e.clientX, e.clientY, e.target)) return;
        e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));
    document.addEventListener('mouseup',   () => { dragging = false; });

    // Touch — only on non-fullscreen (tablet/landscape); fullscreen shell is JS-sized anyway
    handle.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        if (!startDrag(t.clientX, t.clientY, e.target)) return;
    }, { passive: true });
    handle.addEventListener('touchmove', (e) => {
        if (!dragging) return;
        e.preventDefault();
        const t = e.touches[0];
        moveDrag(t.clientX, t.clientY);
    }, { passive: false });
    handle.addEventListener('touchend', () => { dragging = false; });
}

// ─────────────────────────────────────────────────────────────────────────
// Render router
// ─────────────────────────────────────────────────────────────────────────

async function rerender() {
    if (!phoneRoot) return;
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    const screen = phoneRoot.querySelector('#smart-phone-screen');

    phoneRoot.querySelectorAll('.smart-phone-tab').forEach((t) => {
        t.classList.toggle('active', t.dataset.app === currentApp);
    });

    let html = '';
    switch (currentApp) {
        case 'messages':
            if (currentThread) {
                // v0.14.0 群聊 thread 走 renderGroupThread，单聊 thread 走 renderThread
                html = isGroupThread(currentThread)
                    ? renderGroupThread(chatId, currentThread)
                    : renderThread(chatId, currentThread);
            } else {
                const subTabHdr = renderMessagesSubTabs(currentMessagesSubTab);
                html = subTabHdr + (currentMessagesSubTab === 'contacts'
                    ? renderContactsTab()
                    : renderMessageList(chatId));
            }
            break;
        case 'moments':
            html = renderMoments(chatId, State.load().contacts, getContext()?.name1 || '我');
            break;
        case 'forum':
            html = renderForum(chatId);
            break;
        case 'xhs':
            html = renderXHS(chatId);
            break;
        case 'settings':
            html = await renderSettings();
            break;
    }
    screen.innerHTML = html;

    if (currentApp === 'messages') {
        // Sub-tab toggle
        screen.querySelectorAll('.phone-msg-subtab').forEach((btn) => {
            btn.addEventListener('click', () => { currentMessagesSubTab = btn.dataset.subtab; rerender(); });
        });

        if (!currentThread) {
            if (currentMessagesSubTab === 'chats') {
                screen.querySelectorAll('.phone-list-item').forEach((row) => {
                    // 短按 = 进入会话
                    row.addEventListener('click', () => {
                        if (row._suppressClick) { row._suppressClick = false; return; }
                        currentThread = row.dataset.threadType === 'group'
                            ? row.dataset.threadId
                            : row.dataset.thread;
                        if (selectionMode) exitSelectionMode();
                        pendingPostCommand = null;
                        rerender();
                    });
                    // v0.14.2 长按/右键 = 删除该聊天（微信式）
                    const triggerDelete = () => {
                        const isGroup = row.dataset.threadType === 'group';
                        const threadId = isGroup ? row.dataset.threadId : row.dataset.thread;
                        showChatDeleteMenu(threadId, isGroup, row);
                    };
                    row.addEventListener('contextmenu', (e) => {
                        e.preventDefault();
                        triggerDelete();
                    });
                    let lpTimer = null;
                    let lpStart = null;
                    row.addEventListener('touchstart', (e) => {
                        lpStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                        if (lpTimer) clearTimeout(lpTimer);
                        lpTimer = setTimeout(() => {
                            row._suppressClick = true; // 长按触发后禁用本次 click
                            try { navigator.vibrate && navigator.vibrate(50); } catch {}
                            triggerDelete();
                        }, 600);
                    }, { passive: true });
                    row.addEventListener('touchmove', (e) => {
                        if (!lpTimer || !lpStart) return;
                        const dx = Math.abs(e.touches[0].clientX - lpStart.x);
                        const dy = Math.abs(e.touches[0].clientY - lpStart.y);
                        if (dx > 10 || dy > 10) { clearTimeout(lpTimer); lpTimer = null; }
                    }, { passive: true });
                    row.addEventListener('touchend', () => {
                        if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
                    });
                });
                // v0.14.0 创建群聊按钮（聊天列表顶部 + 空状态）
                screen.querySelector('#phone-create-group-btn')?.addEventListener('click', openCreateGroupModal);
                screen.querySelector('#phone-create-group-empty')?.addEventListener('click', openCreateGroupModal);
            } else {
                // Contacts sub-tab handlers (same handlers as settings contacts section)
                screen.querySelectorAll('.phone-gen-ref').forEach((btn) => {
                    btn.addEventListener('click', () => handleGenRef(btn.dataset.name, btn));
                });
                screen.querySelectorAll('.phone-lock-ref').forEach((btn) => {
                    btn.addEventListener('click', () => handleLockRef(btn.dataset.name));
                });
                screen.querySelectorAll('.phone-contact-anchor-edit').forEach((inp) => {
                    const save = () => handlePromptEdit(inp.dataset.name, inp.value.trim());
                    inp.addEventListener('blur', save);
                    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); inp.blur(); } });
                });
                screen.querySelectorAll('.phone-contact-ref[src]').forEach((img) => {
                    img.addEventListener('click', () => window.open(img.src, '_blank'));
                });
                screen.querySelectorAll('.phone-gen-appearance').forEach((btn) => {
                    btn.addEventListener('click', () => handleGenerateAppearance(btn.dataset.name, btn));
                });
                // v0.14.1 / v0.14.2 联系人 tab 「💬 开始聊天」 → 加进 activeChats + 进入会话
                screen.querySelectorAll('.phone-start-chat').forEach((btn) => {
                    btn.addEventListener('click', () => {
                        const name = btn.dataset.name;
                        if (!name) return;
                        const ctx = getContext();
                        const chatId = ctx.chatId || 'default';
                        State.activateChatThread(chatId, name);
                        currentThread = name;
                        currentMessagesSubTab = 'chats';
                        if (selectionMode) exitSelectionMode();
                        pendingPostCommand = null;
                        rerender();
                    });
                });
                // v0.14.5 「显示所有世界书联系人」开关
                const showAllChk = screen.querySelector('#phone-contacts-show-all');
                if (showAllChk) {
                    showAllChk.addEventListener('change', (e) => handleShowAllContactsToggle(e.target.checked));
                }
                // v0.14.10 陌生人折叠区交互
                const stToggle = screen.querySelector('#phone-stranger-toggle');
                if (stToggle) {
                    stToggle.addEventListener('click', () => {
                        const body = screen.querySelector('.phone-stranger-body');
                        const arrow = stToggle.querySelector('.phone-stranger-toggle-arrow');
                        const isCollapsed = body.style.display === 'none';
                        body.style.display = isCollapsed ? 'block' : 'none';
                        if (arrow) arrow.textContent = isCollapsed ? '▼' : '▶';
                        sessionStorage.setItem('phone-stranger-section-collapsed', isCollapsed ? 'false' : 'true');
                    });
                }
                screen.querySelectorAll('.phone-stranger-edit').forEach(b => {
                    b.addEventListener('click', () => openStrangerEditModal(b.dataset.name));
                });
                screen.querySelectorAll('.phone-stranger-promote').forEach(b => {
                    b.addEventListener('click', () => promoteStrangerHandler(b.dataset.name));
                });
                screen.querySelectorAll('.phone-stranger-delete').forEach(b => {
                    b.addEventListener('click', () => deleteStrangerHandler(b.dataset.name));
                });
            }
        } else {
            screen.querySelector('[data-back]')?.addEventListener('click', () => {
                currentThread = null;
                if (selectionMode) exitSelectionMode();
                pendingPostCommand = null;
                rerender();
            });
            screen.querySelector('#phone-reroll-btn')?.addEventListener('click', handleReroll);
            // 🗂 multi-select toggle (alternative entry to long-press)
            screen.querySelector('#phone-multiselect-btn')?.addEventListener('click', () => {
                if (selectionMode) exitSelectionMode();
                else enterSelectionMode();
            });
            // 📤 命令角色发帖 (Phase D)
            screen.querySelector('#phone-cmd-post-btn')?.addEventListener('click', () => {
                if (currentThread) openCommandPostModal(currentThread);
            });
            // v0.14.0 📷 群聊生图按钮
            screen.querySelector('#phone-group-photo-btn')?.addEventListener('click', (e) => {
                const gid = e.currentTarget.dataset.groupId;
                if (gid) openGroupPhotoModeModal(gid);
            });
            // v0.14.0 ⚙ 群设置按钮
            screen.querySelector('#phone-group-settings-btn')?.addEventListener('click', (e) => {
                const gid = e.currentTarget.dataset.groupId;
                if (gid) openGroupSettingsModal(gid);
            });
            const input = screen.querySelector('#phone-input');
            const sendBtn = screen.querySelector('#phone-send-btn');
            const send = () => handleSendSMS(input?.value?.trim() || '');
            sendBtn?.addEventListener('click', send);
            input?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            });
            // Auto-scroll thread to bottom
            const body = screen.querySelector('#phone-thread-body');
            if (body) body.scrollTop = body.scrollHeight;
            // Wire bubble edit (single-tap reveals pencil; pencil swaps content for textarea)
            wireBubbleEditing(screen);
        }
    }
    if (currentApp === 'xhs') {
        bindXHSHandlers(screen, {
            onCompose: () => { xhsSetView('compose'); rerender(); },
            onRefresh: handleXhsRefresh,
            onClear: handleXhsClear,
            onOpenPost: (id) => { xhsSetView('detail', id); rerender(); },
            onBackToFeed: () => { xhsSetView('feed'); rerender(); },
            onSubmit: handleXhsSubmit,
        });
    }
    if (currentApp === 'moments') {
        bindMomentsHandlers(screen, {
            onRefresh: handleMomentsRefresh,
            onClear: handleMomentsClear,
            onCompose: () => { momentsSetView('compose'); rerender(); },
            onBackToFeed: () => { momentsSetView('feed'); rerender(); },
            onSubmit: handleMomentsSubmit,
            onLike: handleMomentsLike,
            onComment: handleMomentsComment,
        });
    }
    if (currentApp === 'forum') {
        bindForumHandlers(screen, {
            onRefresh: handleForumRefresh,
            onClear: handleForumClear,
            onOpenPost: (id) => { forumSetView('detail', id); rerender(); },
            onBackToFeed: () => { forumSetView('feed'); rerender(); },
            onCompose: () => { forumSetView('compose'); rerender(); },
            onSubmit: handleForumSubmit,
            onReply: (text) => handleForumReply(getForumDetailId(), text),
        });
    }
    if (currentApp === 'settings') {
        bindSettingsHandlers(screen, {
            onImportContact: handleImportContact,
            onGenRef: handleGenRef,
            onLockRef: handleLockRef,
            onRemoveContact: handleRemoveContact,
            onModelChange: handleModelChange,
            onComfyuiUrlChange: handleComfyuiUrlChange,
            onToggleLore: handleToggleLore,
            onToggleWorldContext: handleToggleWorldContext,
            onRefresh: handleSettingsRefresh,
            onApiSave: handleApiSave,
            onApiTest: handleApiTest,
            onApiTriggerNow: () => toastr.info('该功能保留给手动调用，目前消息生成走主聊天 AI'),
            onComfyuiTest: handleComfyuiTest,
            onFetchModels: handleFetchModels,
            onPromptEdit: handlePromptEdit,
            onGenAppearance: handleGenerateAppearance,
            // World-book scoped contacts (v0.10.4)
            onShowAllToggle: handleShowAllContactsToggle,
            onBatchAssignOrphans: openBatchAssignOrphansModal,
            onDeleteOrphans: handleDeleteAllOrphans,
            onImportFromOtherWorld: openImportFromOtherWorldModal,
            onEditContactSourceBook: openEditContactSourceBookModal,
            onCleanupOrphanChats: openCleanupOrphanChatStatesModal,
        });
    }

    // Global reroll handler — single source of truth for all `.phone-img-reroll-btn` buttons
    // emitted by renderImagesGrid. Replaces per-app onRerollPic wiring.
    screen.querySelectorAll('.phone-img-reroll-btn').forEach((/** @type {HTMLButtonElement} */ btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const picTag = btn.dataset.pic;
            if (picTag) rerollPicSlot(picTag);
        });
    });

    triggerPicSlots(screen);

    // Re-apply .selected to cells whose URL is in the current selection set (selection survives re-render)
    reapplySelectionToVisibleCells();
    updateSelectionToolbar();
}

// ─────────────────────────────────────────────────────────────────────────
// Event wiring
// ─────────────────────────────────────────────────────────────────────────

function bindEvents() {
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.MESSAGE_UPDATED, onMessageReceived); // re-parse on edits
    // v0.14.50 双 Pass 真并行：监听流式 token → 检测完整 SMS 块 → 立即用独立 API 通道
    // 启动 Pass 2，跟 Pass 1 同时跑（callPhoneApi 不阻塞 ST 主流）
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.CHAT_CHANGED, () => {
        currentThread = null;
        if (selectionMode) exitSelectionMode();
        pendingPostCommand = null;
        xhsSetView('feed'); forumSetView('feed'); momentsSetView('feed');
        rerender();
    });
}

function onPromptReady(eventData) {
    const s = State.load();
    if (!s.enabled) return;

    // v0.14.26 检测插件内部 quiet 调用（NPC 评论 / 视觉档案外貌生成 等走 generateQuietPrompt
    // 路径），跳过 strip + 协议 push。否则 AI 会把 NPC 评论请求当成手机指令，输出 PHONE 块
    // 而不是我们需要的 JSON 数组，导致朋友圈/论坛/小红书 NPC 评论生成失败。
    if (window.__smartPhoneInternalQuietCall) return;

    // v0.14.24 单轨化 STEP 1：原地 strip 预设的格式/字数/扩写冲突 token。
    // 在 chat 数组上修改，让 AI 看不到 <输出模板> / <正文> / 字数 / 扩写任务等。
    // 比 prompt 描述层"覆盖"更稳：直接从输入剥掉冲突指令。
    if (Array.isArray(eventData.chat)) {
        for (const msg of eventData.chat) {
            if (msg && typeof msg.content === 'string') {
                msg.content = Protocol.stripConflictingPresetTokens(msg.content);
            }
        }
    }

    const contacts = s.contacts.map((c) => ({ name: c.name, note: c.note }));
    const lore = (s.worldbook?.importedEntries || []).filter((e) => e.type === 'lore' && e.enabled);

    // v0.14.0 当前 thread 是群聊时，主动注入所有群成员的核心人设
    // 绕过 ST 默认关键词触发机制，让 AI 看见每个成员的口癖/性格/称呼
    let activeGroup = null;
    if (currentThread && isGroupThread(currentThread)) {
        const group = State.findGroup(currentThread);
        if (group) {
            const members = State.resolveGroupMembers(group)
                .filter(m => !m.isDeleted && m.contact)
                .map(m => ({
                    name: m.nameSnapshot,
                    // 抽 contact.rawContent 前 1500 字符作为核心人设档案
                    profile: (m.contact.rawContent || m.contact.note || '').slice(0, 1500),
                }));
            activeGroup = { name: group.name, members };
        }
    }

    // v0.14.8 传当前 SD 模型 → protocol 按 model 给陌生角色不同 pic prompt 建议
    const currentModel = s.imageGen?.currentModel || 'wai_anihentai';

    // v0.14.39 检测本回合是否 STRICT 手机指令模式（用户消息含 [实时手机指令——]）
    // v0.14.40 进一步检测是否明确请求图片（仅 STRICT + image-request 才注入 AV 多图）。
    // v0.14.44 ⚠️ 关键修复：之前 4 个正则全要求 `[` 或 `【` 前缀，但 makeRequestSafe 把这些括号
    //   剥成空格 → 用户消息里只有裸的 `实时手机指令——手机短信`，正则全部失败 → isStrictTurn
    //   永远 false → noPicMetaRule / AV 段从未注入 → AI 只能靠 protocol 自然语言 "Request:" 启发式
    //   判 STRICT，regenerate 时尤其不稳（reroll 命中率骤降）。改成匹配实际存活的裸标记。
    // 缺一不可：
    //   STRICT + image-request → AV 多图（含 pic）
    //   STRICT + 无 image-request → 纯文字 SMS/GMSG，无 pic
    //   非 STRICT → 正常 RP prose
    // v0.14.44 audit fix: 协议里 3 个 OOC builder 用了 2 种分隔符（buildSendOOC 用 ——；
    //   buildPostOOC + buildGroupPostCommandOOC 用 ·），且 buildGroupPostCommandOOC 的 marker
    //   词是 "实时群聊生图指令" 不是 "实时手机指令"。需同时覆盖 3 种变体。
    const STRICT_MARKER_RE = /实时(?:手机指令|群聊生图指令)[·—]/;
    const IMAGE_REQUEST_RE = /(照片|相片|图片|图像|拍照|拍张|拍个|拍组|拍.{0,5}张|拍.{0,5}相|拍腿|拍奶|拍胸|拍屁股|拍小穴|拍逼|拍阴|拍脚|拍脸|拍全身|拍背|拍脖|拍肩|拍腰|拍上半身|拍下半身|发图|发照|发张|发一张|发几张|发个图|发一组|发自拍|发个|发组|看看你|看看她|看看妈|看看姐|看看你的|看看她的|看看妈的|看看姐的|给我看|让我看|让.{1,3}看|让大家看|让他们看|让他看|让她看|自拍|穿搭|镜子前|视频|录像|直播|走光|露(?:点|奶|逼|穴|胸|屁股)|脱.{0,3}拍|脱了发|show me|selfie)/i;
    let isStrictTurn = false;
    let isImageRequest = false;
    if (Array.isArray(eventData.chat)) {
        for (let i = eventData.chat.length - 1; i >= 0; i--) {
            const msg = eventData.chat[i];
            if (!msg || msg.role !== 'user') continue;
            const txt = String(msg.content || '');
            if (STRICT_MARKER_RE.test(txt)) {
                isStrictTurn = true;
            }
            // v0.14.44 audit fix: 原想用 /用户发送的短信内容[：:]\s*「(.+?)」/ 抽 user 真实输入，
            // 但 makeRequestSafe 把 「」 剥成空格了 → 闭合括号永不命中；JS 无 m flag 时 $ 只匹配整串
            // 末尾、加上 lazy {1,200}? 也找不到干净边界 → 正则永远 fall-through 到 txt 整段。
            // 索性直接对 txt 整段做 IMAGE_REQUEST 检测：image keyword（拍照/发图/看看你）只会出现
            // 在 user 真实文本里；OOC 的 conditional hint（imageHint/countHint/bodyPartHint）本身就是
            // user 命中关键词时才追加的，自洽不会假阳。
            if (IMAGE_REQUEST_RE.test(txt)) {
                isImageRequest = true;
            }
            break; // 只看最后一条 user 消息
        }
    }
    const includeAVSections = isStrictTurn && isImageRequest;
    // v0.14.43 NPC 排除名单（user 点 🎲 换 NPC 后注入）
    const rerollExclude = (window.__smartPhone_rerollExcludeNpcs && window.__smartPhone_rerollExcludeNpcs.size > 0)
        ? Array.from(window.__smartPhone_rerollExcludeNpcs)
        : [];
    // v0.14.49 双 Pass 加速模式（实验性，settings.imageGen.splitPicGen 控制）
    const splitPicGen = !!s.imageGen?.splitPicGen;
    const styleRule = Protocol.buildProtocolPrompt({
        contacts, lore, activeGroup, currentModel, includeAVSections, isStrictTurn, isImageRequest,
        rerollExcludeNpcs: rerollExclude,
        splitPicGen,
    });

    // v0.14.24 单轨化 STEP 2：strip 之后再 push 协议（协议本身免疫被洗）。
    // 协议放 chat 末尾让它成为 AI 看到的最后一段（位置最高权重）。
    eventData.chat.push({ role: 'system', content: styleRule });
}

// v0.14.30 同 FROM 连续 ≥ 2 条 SMS 的 TIME 单调重排
// 用途：AI 输出 AV 多图叙事时往往 TIME 算术不可靠（重复/倒退/超 60 分）。
// 策略：找连续同 FROM 段 → 基线 = 第一条原 TIME → 后续每条 +random(2,8) 分钟。
// 副作用：普通连发 2-3 条短信也会被规整（间隔 2-8 分钟），可接受。
function parseHHMM(s) {
    if (!s || typeof s !== 'string') return null;
    const m = s.trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
    return h * 60 + mm;
}
function formatHHMM(totalMinutes) {
    let mm = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
    const h = Math.floor(mm / 60), m = mm % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function normalizeSmsTimes(smsArr) {
    if (!Array.isArray(smsArr) || smsArr.length < 2) return;
    // 按 emission 顺序找同 FROM 连续段
    let i = 0;
    while (i < smsArr.length) {
        let j = i;
        while (j < smsArr.length && smsArr[j].from === smsArr[i].from) j++;
        const groupLen = j - i;
        if (groupLen >= 2) {
            // 基线：优先用第一条原 TIME（合法 HH:MM），否则用当前墙钟
            let minutes = parseHHMM(smsArr[i].time);
            if (minutes === null) {
                const d = new Date();
                minutes = d.getHours() * 60 + d.getMinutes();
            }
            for (let k = i; k < j; k++) {
                smsArr[k].time = formatHHMM(minutes);
                minutes += 2 + Math.floor(Math.random() * 7); // +2..+8 分钟
            }
        }
        i = j;
    }
}

// v0.14.37 群聊 TIME 单调重排：群聊里 N 个成员交错发言，所有 GMSG 按 emission
// 顺序统一时间轴递增（不按 FROM 分组）。AV 多图叙事可能有 10+ 条 GMSG，间隔可
// 比 SMS 小（群聊本就更密集），用 +0..+3 分钟更自然。
function normalizeGroupTimes(groupArr) {
    if (!Array.isArray(groupArr) || groupArr.length < 2) return;
    let minutes = parseHHMM(groupArr[0].time);
    if (minutes === null) {
        const d = new Date();
        minutes = d.getHours() * 60 + d.getMinutes();
    }
    for (let i = 0; i < groupArr.length; i++) {
        groupArr[i].time = formatHHMM(minutes);
        // 群聊节奏更密，0-3 分钟之内变化（有的连发瞬间）
        minutes += Math.floor(Math.random() * 4);
    }
}

// v0.14.59 ⭐⭐⭐ 真正并行 — 跟主 AI thinking 完全并行的图片预生成
// GENERATION_STARTED 时不等 AI，立即用 user 文本启动 phone-api 生成 prompt + fire ComfyUI
// onMessageReceived 时按 AI 写的 pic 顺序把 prefired URLs 写入 picUrlCache
const _prefireState = {
    active: false,           // 本回合是否预生成
    userMsgIdx: -1,          // 哪条 user 消息触发的（防重）
    urlPromises: [],         // ComfyUI Promise<URL>[] 列表
    target: '',              // 角色名
};

function _resetPrefireState() {
    _prefireState.active = false;
    _prefireState.userMsgIdx = -1;
    _prefireState.urlPromises = [];
    _prefireState.target = '';
}

// v0.14.50 双 Pass stream-fire 状态（保留作 AV 多镜头兜底）
// 当用户消息含 AV 关键词（pre-fire 跳过），stream 期间扫到 <pic .../> 才 fire
const _passTwoState = {
    activeUserText: '',
    splitPicGenEnabled: false,
    parallelAvailable: false,
    firedSmsKeys: new Set(),
    pendingPromises: new Map(),
    lastBufferLength: 0,
};

function _resetPassTwoState() {
    _passTwoState.activeUserText = '';
    _passTwoState.splitPicGenEnabled = false;
    _passTwoState.parallelAvailable = false;
    _passTwoState.firedSmsKeys.clear();
    _passTwoState.pendingPromises.clear();
    _passTwoState.lastBufferLength = 0;
}

async function onGenerationStarted(type) {
    if (window.__smartPhoneInternalQuietCall) return;
    _resetPassTwoState();
    _resetPrefireState();
    const s = State.load();
    if (!s.enabled) return;

    // 拿当前回合 user 文本
    const ctx = getContext();
    const chat = ctx?.chat || [];
    let userText = '';
    let userMsgIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user) {
            userText = chat[i].mes || '';
            userMsgIdx = i;
            break;
        }
    }
    if (!userText) return;

    // 旧 stream-fire 状态填充（作 AV 兜底用）
    _passTwoState.activeUserText = userText;
    if (s.imageGen?.splitPicGen) {
        _passTwoState.splitPicGenEnabled = true;
        const apiCfg = s.api || {};
        _passTwoState.parallelAvailable = !!(apiCfg.url && apiCfg.key);
    }

    // 启发式判断是否预生成
    const intent = analyzeUserIntent(userText);
    if (intent.mode === 'av') {
        console.log('[smart-phone v0.14.59] AV 多镜头模式 → 跳过 pre-fire（让 stream 兜底 AI 出 STAGE 序列）');
        return;
    }
    if (intent.mode === 'skip' || !intent.wantsPic) {
        console.log('[smart-phone v0.14.59] user 无图片诉求 → 跳过 pre-fire');
        return;
    }

    // 检查 phone-api 配置
    const apiCfg = s.api || {};
    if (!apiCfg.url || !apiCfg.key) {
        console.log('[smart-phone v0.14.59] phone-api 未配置 → 跳过 pre-fire（回退到 stream-fire）');
        return;
    }
    if (!window.smartImageGen?.generateFromPicTag) {
        console.log('[smart-phone v0.14.59] smart-image-gen 不可用 → 跳过 pre-fire');
        return;
    }

    // 推断角色 + anchor
    const target = inferTarget({
        chatId: ctx.chatId || 'default',
        currentThread,
        isGroupThread,
        userText,
        contacts: s.contacts || [],
        getActiveGroups: State.getActiveGroups,
        findGroup: State.findGroup,
    });
    if (!target) {
        console.log('[smart-phone v0.14.59] 无法推断 target → 跳过 pre-fire');
        return;
    }
    let anchor = '';
    const contact = (s.contacts || []).find(c => c.name === target);
    if (contact?.anchor) anchor = contact.anchor.sdPrompt || contact.anchor.prompt || '';
    if (!anchor) {
        const sa = State.getStrangerAnchor?.(ctx.chatId || 'default', target);
        if (sa?.core) anchor = sa.core;
    }

    // ⚡⚡⚡ 启动预生成（不 await，让它跟主 AI thinking 并行）
    _prefireState.active = true;
    _prefireState.userMsgIdx = userMsgIdx;
    _prefireState.target = target;
    console.log(`[smart-phone v0.14.59] ⚡⚡⚡ pre-fire 启动 (target=${target}, count=${intent.count}, scene=${intent.sceneHint || '通用'})`);

    // 注意：prefirePics 内部串行调 phone-api（每个 prompt 一个），并行 fire ComfyUI
    // 用 .then 立即把 Promise<URL>[] 存到状态，不 await
    prefirePics({
        userText,
        target,
        anchor,
        count: intent.count,
        sceneHint: intent.sceneHint,
        currentModel: s.imageGen?.currentModel || 'wai_anihentai',
        smartImageGen: window.smartImageGen,
        contacts: s.contacts || [],
    }).then(urlPromises => {
        _prefireState.urlPromises = urlPromises;
        console.log(`[smart-phone v0.14.59] pre-fire prompts 全部就绪，${urlPromises.length} 个 ComfyUI Promise 已 fire`);
    }).catch(err => {
        console.warn('[smart-phone v0.14.59] pre-fire 启动失败:', err);
        _prefireState.active = false;
    });
}

// v0.14.57 共享辅助 — fire ComfyUI 出图，存 Promise 到 picUrlCache 让 triggerPicSlots 复用
// 调用时机：stream 检测到完整 <SMS><pic prompt="..."/></SMS>（picTag 现成）→ 立即 fire
// 也用于：Pass 2 booru prompt resolve 后构造 picTag → fire
function _firePrefireComfyUI(finalPicTag, picInner, target) {
    if (!window.smartImageGen?.generateFromPicTag) return;
    if (picUrlCache.has(finalPicTag)) return; // 已在跑/已 resolved，不重复 fire
    // 持久化 cache 命中（user 重发同内容）→ 直接填内存 cache 不 fire ComfyUI
    try {
        const _ctx = getContext();
        const _chatId = _ctx?.chatId || 'default';
        const persisted = State.getPicUrl(_chatId, finalPicTag);
        if (persisted) {
            picUrlCache.set(finalPicTag, persisted);
            return;
        }
    } catch {}
    // SUBJECTS 属性（多角色合影）走 generateGroupPicTag
    const subjectsMatch = picInner?.match(/SUBJECTS\s*=\s*"([^"]+)"/i);
    const subjects = subjectsMatch ? subjectsMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];
    const useGroupPic = subjects.length > 1 && window.smartImageGen?.generateGroupPicTag;
    const contacts = State.load().contacts;
    const hint = { from: target, source: 'sms' };
    const generator = useGroupPic
        ? () => window.smartImageGen.generateGroupPicTag(finalPicTag, { contacts, subjects, hint })
        : () => window.smartImageGen.generateFromPicTag(finalPicTag, { contacts, hint });
    const genPromise = generator()
        .then((url) => {
            picUrlCache.set(finalPicTag, url);
            try {
                const _ctx2 = getContext();
                const _chatId2 = _ctx2?.chatId || 'default';
                if (url) State.setPicUrl(_chatId2, finalPicTag, url);
            } catch {}
            return url;
        })
        .catch((err) => { picUrlCache.delete(finalPicTag); throw err; });
    picUrlCache.set(finalPicTag, genPromise);
    console.log(`[smart-phone v0.14.57] ⚡⚡ stream-prefire ComfyUI fire (target=${target}, picTag=${finalPicTag.slice(0, 80)}…)`);
}

// v0.14.59 流式兜底 — 只在 pre-fire 未启用（AV 模式 / 无 phone-api / 推断失败）时才走
// 用 stream 期间扫到的 <pic .../> 触发 ComfyUI。pre-fire 在跑时这里直接跳过（避免重复 fire 浪费）。
// 双路径保留：
//   (a) <pic prompt="..."/> → 直接 fire ComfyUI
//   (b) <pic/> 空占位（splitPicGen 模式）→ Pass 2 生成 prompt → fire ComfyUI
async function onStreamToken(accumulatedText) {
    if (typeof accumulatedText !== 'string') return;
    if (!window.smartImageGen?.generateFromPicTag) return;
    if (_prefireState.active) return; // ⭐ pre-fire 已启动，不走 stream-fire（避免重复）
    if (accumulatedText.length === _passTwoState.lastBufferLength) return;
    _passTwoState.lastBufferLength = accumulatedText.length;

    // 直接扫完整 <pic .../> 标签 — 不等 </SMS>，pic 一闭合就触发
    const picRe = /<pic\b([^>]*?)\/>/gi;
    let pm;
    while ((pm = picRe.exec(accumulatedText)) !== null) {
        const fullPicTag = pm[0];
        const picInner = pm[1] || '';
        const picStartIdx = pm.index;
        // 去重 key — 用完整 picTag（含 prompt 内容）作 key，同 picTag 重复出现不重 fire
        const dedupeKey = fullPicTag;
        if (_passTwoState.firedSmsKeys.has(dedupeKey)) continue;

        // 找最近一个 <SMS|GMSG attrs> 开标签作 target 来源 — 从 picStartIdx 倒着找
        const beforePic = accumulatedText.slice(0, picStartIdx);
        // 倒查最近的 SMS 或 GMSG 开标签（含 attrs）
        let attrs = '';
        const lastSmsOpen = beforePic.lastIndexOf('<SMS');
        const lastGmsgOpen = beforePic.lastIndexOf('<GMSG');
        const lastOpen = Math.max(lastSmsOpen, lastGmsgOpen);
        if (lastOpen >= 0) {
            const tail = beforePic.slice(lastOpen);
            const openTagMatch = tail.match(/^<(?:SMS|GMSG)\s+([^>]*)>/i);
            if (openTagMatch) attrs = openTagMatch[1];
        }
        const fromMatch = attrs.match(/FROM\s*=\s*"([^"]+)"/i);
        const subjectMatch = attrs.match(/SUBJECT\s*=\s*"([^"]+)"/i);
        const target = (subjectMatch?.[1] || fromMatch?.[1] || '').trim();

        const hasPrompt = /\sprompt\s*=/i.test(picInner);

        if (hasPrompt) {
            // 路径 A：AI 写完整 prompt → 直接 fire ComfyUI
            _passTwoState.firedSmsKeys.add(dedupeKey);
            console.log(`[smart-phone v0.14.58] ⚡⚡ pic 写完立即 fire ComfyUI (target=${target})`);
            _firePrefireComfyUI(fullPicTag, picInner, target);
        } else if (_passTwoState.splitPicGenEnabled && _passTwoState.parallelAvailable) {
            // 路径 B：空 <pic/>（splitPicGen 模式）→ Pass 2 生成 prompt → fire ComfyUI
            _passTwoState.firedSmsKeys.add(dedupeKey);
            const state = State.load();
            const ctxLocal = getContext();
            const chatId = ctxLocal.chatId || 'default';
            let anchor = '';
            const contact = state.contacts.find(c => c.name === target);
            if (contact?.anchor) anchor = contact.anchor.sdPrompt || contact.anchor.prompt || '';
            if (!anchor) {
                const sa = State.getStrangerAnchor?.(chatId, target);
                if (sa?.core) anchor = sa.core;
            }
            // SMS content 上下文 — 从 picStartIdx 之前的 SMS 开标签起取内容（如有）
            let smsContent = '';
            if (lastSmsOpen >= 0) {
                const sliceFrom = beforePic.indexOf('>', lastSmsOpen);
                if (sliceFrom >= 0) smsContent = beforePic.slice(sliceFrom + 1).replace(/<pic\b[^>]*\/?>/gi, '').trim();
            }
            // 用 sms content text 作 Pass 2 pending key（跟 fillPlaceholderPicsViaPass2 端 m.content 对齐）
            const passTwoKey = smsContent.slice(0, 80);
            const promise = generatePicPromptViaPhoneApi({
                targetName: target,
                smsContent,
                userText: _passTwoState.activeUserText,
                contactAnchor: anchor,
                currentModel: state.imageGen?.currentModel || 'wai_anihentai',
            });
            _passTwoState.pendingPromises.set(passTwoKey, promise);
            console.log(`[smart-phone v0.14.58] ⚡ <pic/> placeholder → Pass 2 (target=${target})`);
            const capturedPicInner = picInner;
            const capturedTarget = target;
            promise.then((booruPrompt) => {
                if (!booruPrompt) return;
                const safePrompt = booruPrompt.replace(/"/g, '&quot;');
                const finalPicTag = `<pic prompt="${safePrompt}"${capturedPicInner || ''}/>`;
                _firePrefireComfyUI(finalPicTag, capturedPicInner, capturedTarget);
            }).catch(() => {});
        }
    }
}

// v0.14.49 ⭐ Pass 2 — 检测 <pic/> 占位符 + 后台 quiet AI 生成 booru prompt 填回
// 串行处理（generateQuietPrompt 不并发安全），所以 N 张图慢 N×~1.5s
// 但 Pass 1 已经省了 N×~30 tokens 输出，整体仍比单 Pass 快
function isPicPlaceholder(picTag) {
    return typeof picTag === 'string' && picTag.length > 0 && !/\sprompt\s*=/i.test(picTag);
}

async function fillPlaceholderPicsViaPass2(parsed, chatId, userText) {
    const state = State.load();
    const sdModel = state.imageGen?.currentModel || 'wai_anihentai';

    // 找全角色 anchor 查表 — 看 subject 优先，回退 from
    const findAnchor = (targetName) => {
        if (!targetName) return '';
        const contact = state.contacts.find(c => c.name === targetName);
        if (contact?.anchor) return contact.anchor.sdPrompt || contact.anchor.prompt || '';
        const sa = State.getStrangerAnchor?.(chatId, targetName);
        if (sa?.core) return sa.core;
        return '';
    };

    // 收集所有需要 Pass 2 的 ref：{ msg, target, smsContent, smsKey }
    // v0.14.51 audit fix Bug 1：smsKey 跟 stream 端用同算法 — content text only (no pic tag) [0:80]
    const placeholderRefs = [];
    const collectFrom = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const m of arr) {
            if (m.pic && isPicPlaceholder(m.pic)) {
                // parser 端 m.content 已是不含 <pic> 标签的纯文本，跟 stream 端 strip 后对齐
                const contentTextOnly = (m.content || '').trim();
                const smsKey = contentTextOnly.slice(0, 80);
                placeholderRefs.push({
                    msg: m,
                    target: m.subject || m.from || '',
                    smsContent: m.content || '',
                    smsKey,
                });
            }
        }
    };
    collectFrom(parsed.sms);
    collectFrom(parsed.group);
    collectFrom(parsed.moments);

    if (!placeholderRefs.length) return;

    const parallelMode = _passTwoState.parallelAvailable && _passTwoState.pendingPromises.size > 0;
    console.log(`[smart-phone v0.14.50 Pass 2] ${placeholderRefs.length} 个占位符待填，模式=${parallelMode ? '⚡⚡ 并行(stream-fired)' : '串行(post-message)'}`);
    toastr.info(
        parallelMode
            ? `⚡⚡ 并行 Pass 2: 流式期间已 fire ${_passTwoState.pendingPromises.size} 个 prompt 生成`
            : `⚡ 串行 Pass 2: ${placeholderRefs.length} 张 prompt 后台生成中…`,
        '双 Pass 模式',
        { timeOut: 2500 },
    );

    let success = 0;
    let failed = 0;

    if (parallelMode) {
        // ⚡⚡ 并行模式：stream 期间已 fire 了 Pass 2，这里 await 所有 pending Promises
        // v0.14.51 audit fix Bug 1：用 smsKey 严格匹配（content-based），不再按 index 对位
        // 不匹配的 ref 走 fallback 串行 — 防止顺序错配导致 prompt 串到错误 SMS
        const pendingEntries = [..._passTwoState.pendingPromises.entries()];
        const resolvedByKey = new Map();
        const resolvedResults = await Promise.allSettled(pendingEntries.map(([_, p]) => p));
        for (let i = 0; i < pendingEntries.length; i++) {
            const [key] = pendingEntries[i];
            const r = resolvedResults[i];
            if (r.status === 'fulfilled' && r.value) resolvedByKey.set(key, r.value);
        }
        for (const ref of placeholderRefs) {
            let generatedPrompt = resolvedByKey.get(ref.smsKey) || null;
            if (!generatedPrompt) {
                // stream 没抓到（截断/正则没命中）→ fallback 串行
                console.log(`[smart-phone v0.14.51] smsKey "${ref.smsKey.slice(0,40)}…" 没在 pending 里，走 fallback 串行`);
                try {
                    generatedPrompt = await generatePicPromptForContext({
                        targetName: ref.target,
                        smsContent: ref.smsContent,
                        userText,
                        contactAnchor: findAnchor(ref.target),
                        currentModel: sdModel,
                    });
                } catch {}
            }
            if (generatedPrompt) {
                const safePrompt = generatedPrompt.replace(/"/g, '&quot;');
                // v0.14.51 audit fix Bug 2：用 replacer function，避免 prompt 含 $ 字符被
                // .replace 当 backref 处理（如 $1/$2 会被替换成捕获组内容 → 出 bug）
                ref.msg.pic = ref.msg.pic.replace(
                    /<pic\b([^>]*)\/?>/i,
                    (_match, p1) => `<pic prompt="${safePrompt}"${p1 || ''}/>`,
                );
                success++;
            } else {
                failed++;
            }
        }
    } else {
        // 串行模式（phone-api 没配 / stream 没触发）
        for (const ref of placeholderRefs) {
            try {
                const anchor = findAnchor(ref.target);
                const generatedPrompt = await generatePicPromptForContext({
                    targetName: ref.target,
                    smsContent: ref.smsContent,
                    userText,
                    contactAnchor: anchor,
                    currentModel: sdModel,
                });
                const safePrompt = generatedPrompt.replace(/"/g, '&quot;');
                // v0.14.51 audit fix Bug 2：用 replacer function 防 prompt 含 $ 被当 backref
                ref.msg.pic = ref.msg.pic.replace(
                    /<pic\b([^>]*)\/?>/i,
                    (_match, p1) => `<pic prompt="${safePrompt}"${p1 || ''}/>`,
                );
                success++;
            } catch (err) {
                console.error('[smart-phone v0.14.50 Pass 2] 单个 pic 失败:', err);
                failed++;
            }
        }
    }

    // Reset stream state for next message
    _resetPassTwoState();

    if (failed > 0) {
        toastr.warning(`Pass 2 完成：${success} 成功 / ${failed} 失败`, null, { timeOut: 3000 });
    } else {
        toastr.success(`⚡ Pass 2 完成：${success} 张 prompt（${parallelMode ? '并行' : '串行'}）`, null, { timeOut: 2000 });
    }
}

async function onMessageReceived() {
    const s = State.load();
    if (!s.enabled) return;
    const ctx = getContext();
    const idx = ctx.chat.length - 1;
    const msg = ctx.chat[idx];
    if (!msg || msg.is_user) return;

    // v0.12.3 Bug 3 修复：先剥 <think>/<thinking> 块（DeepSeek-R1/V3 推理模型常加），
    // 再 parse PHONE 块。否则 reasoning prose 漏出来会显示在 ST 气泡里。
    // v0.12.4 加多种推理 wrapper：```thinking / [思考开始] / [REASONING] 等
    if (msg.mes) {
        let cleaned = msg.mes
            // <think>...</think>, <thinking>...</thinking>
            .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
            .replace(/<think(?:ing)?>[\s\S]*$/gi, '')
            // ```thinking ... ```
            .replace(/```(?:thinking|reasoning|thought)[\s\S]*?```/gi, '')
            // 中文 [思考] / [推理] 块
            .replace(/\[思考(?:开始|过程)?\][\s\S]*?\[\/?思考(?:结束)?\]/g, '')
            .replace(/\[REASONING\][\s\S]*?\[\/REASONING\]/gi, '')
            .trim();
        if (cleaned !== msg.mes) {
            msg.mes = cleaned || '📱';
            try { ctx.saveChatDebounced ? ctx.saveChatDebounced() : (ctx.saveChat && ctx.saveChat()); } catch {}
        }
    }

    // v0.14.29 STRICT 模式判定：上一条 user 消息含实时手机指令 → AI 这一轮该只输出 PHONE 块
    // 提前计算用于 reasoning-hint 兜底 + 后续 strip 双模式
    // v0.14.44 audit fix 同 onPromptReady — 兼容 ·（buildPostOOC / buildGroupPostCommandOOC）+ ——（buildSendOOC）
    const _prevUser = idx > 0 ? ctx.chat[idx - 1] : null;
    const _userText = (_prevUser && _prevUser.is_user) ? (_prevUser.mes || '') : '';
    const isStrictMode = /实时(?:手机指令|群聊生图指令)[·—]/.test(_userText);

    // v0.14.46 lenient parser — 3 层尝试（<PHONE> 包裹 → 裸标签 → <PHONE> 截断救援）
    let parsed = Protocol.parsePhoneFromMessage(msg.mes);
    let proseFallbackUsed = false;

    // v0.14.46 Prose fallback — lenient parser 抓不到 + STRICT 模式 + 已知收件人时启用
    // 把 AI 写的散文里第一段对话 / 第一句话合成 SMS 塞进手机 UI，让 ST 主聊天不残留散文
    if (!parsed && isStrictMode && currentThread && !isGroupThread(currentThread) && msg.mes) {
        const synthesized = Protocol.synthesizeSmsFromProse(msg.mes, currentThread, Protocol.nowHHMM());
        if (synthesized) {
            // 包装成完整 PHONE 块再走标准解析 — 保证 metadata（SUBJECT 等）走同一路径
            parsed = Protocol.parsePhoneFromMessage(`<PHONE>${synthesized}</PHONE>`);
            if (parsed) {
                proseFallbackUsed = true;
                console.log('[smart-phone v0.14.46] prose fallback：AI 写散文，已合成 SMS：', synthesized);
            }
        }
    }

    if (!parsed) {
        // Bug 3 兜底：lenient + prose fallback 都失败 → 检测推理特征替换 📱 占位
        // 仅 STRICT 模式触发（NORMAL 模式 AI 本就该写 prose）
        if (isStrictMode && msg.mes && msg.mes.length > 150) {
            const reasoningHints = [
                '好的，我', '好的我', '我需要', '首先', '我们来看看', '让我', '用户的任务',
                '对话连贯性', '用户希望', '考虑到', '所以我', '处理这个用户', '处理用户',
                '用户通过', '用户要求', '用户指定', '根据用户', '根据角色', '根据核心准则',
                '我注意到', '具体输出时', '具体编写', '在编写时', '在具体输出', 'pic prompt 必须',
                '严格遵守', '严格遵循', '在具体回复', '我应该让', '我需要让',
                '现在用户', '现在我', '让我们', '让我们设计', '让我们看', '让我看', '让我先',
                '现在规划', '所以应该', '所以可以', '所以我应该', '我会', '我可以', '注意，',
                '需要避免', '需要注意', '可能问题', '应该输出', '只需要输出', '只需输出',
                '基于这个', '基于以上', '根据上下文', '根据这个', '根据要求',
            ];
            const hits = reasoningHints.filter(h => msg.mes.includes(h)).length;
            if (hits >= 1) {
                msg.mes = '📱（AI 输出推理散文未生成 PHONE 块，请点 ↩ 重新生成）';
                try {
                    const updateBlock = (await import('../../../../script.js')).updateMessageBlock;
                    if (typeof updateBlock === 'function') updateBlock(idx, msg);
                } catch {}
                try { await ctx.saveChat(); } catch {}
            }
        }
        return;
    }

    // Rescue <pic> tags the AI placed in prose (outside PHONE block) — assign them to SMS
    // messages that don't already have a pic, so images still appear in the phone UI.
    if (parsed.sms?.length) {
        const PIC_RE = /<pic\b[^>]*\sprompt="[^"]*"[^>]*\/?>/gi;
        const proseSection = Protocol.stripPhoneBlock(msg.mes);
        const prosePics = [...proseSection.matchAll(PIC_RE)].map((m) => m[0]);
        if (prosePics.length) {
            let pi = 0;
            for (const sms of parsed.sms) {
                if (!sms.pic && pi < prosePics.length) sms.pic = prosePics[pi++];
            }
        }
    }

    // v0.14.30 AV 多图叙事：从 SMS/GMSG pic prompt 里剥 STAGE 标签（不影响 ComfyUI 生图）
    // + TIME 单调重排（防 AI 时钟算术不可靠）。
    // v0.14.31 关键修复：makeRequestSafe 会剥光 [ ] 方括号，换成 @@STAGE:xxx@@ 双 @ 分隔符。
    // v0.14.37 拓展到 parsed.group（群聊 AV 多图叙事），新加 orgy_* / trigger / react_X 阶段。
    //
    // 三选一兼容匹配 + 共享白名单
    const STAGE_IN_PROMPT_RE = /(?:@@\s*STAGE\s*:\s*([\w-]+)\s*@@|\[\s*STAGE\s*:\s*([\w-]+)\s*\]|\bSTAGE\s*:\s*([\w-]+)\b)\s*/gi;
    const VALID_STAGES = new Set([
        // sex_act
        'foreplay','enter','switch','climax','aftermath',
        // exhibition_act
        'prep','display','escalate',
        // oral_act
        'approach','deep','finish',
        // solo_act
        'arousal','peak','afterglow',
        // bdsm_act
        'setup','torment','break','aftercare',
        // v0.14.37 group_orgy
        'orgy_intro','orgy_a','orgy_b','orgy_climax','orgy_aftermath',
        // v0.14.37 group_chain_post
        'trigger','react_1','react_2','react_3','react_4','react_5',
    ]);
    function stripStageFromPic(itemArr) {
        for (const item of itemArr) {
            if (!item.pic) continue;
            const firstM = STAGE_IN_PROMPT_RE.exec(item.pic);
            STAGE_IN_PROMPT_RE.lastIndex = 0;
            if (firstM) {
                const stage = (firstM[1] || firstM[2] || firstM[3] || '').toLowerCase();
                if (stage) {
                    item.stage = stage;
                    if (!VALID_STAGES.has(stage)) {
                        console.warn(`[smart-phone v0.14.37] unknown STAGE label "${stage}" — stripping anyway`);
                    }
                }
                item.pic = item.pic.replace(STAGE_IN_PROMPT_RE, '');
            }
        }
    }
    if (parsed.sms?.length) {
        stripStageFromPic(parsed.sms);
        // SMS 路径：同 FROM 连续 ≥ 2 条 → +2..+8 分钟递增
        normalizeSmsTimes(parsed.sms);
    }
    if (parsed.group?.length) {
        stripStageFromPic(parsed.group);
        // 群聊路径：所有 GMSG 按 emission 顺序单调递增（不按 FROM 分组，群聊里 N 个成员交错发言）
        normalizeGroupTimes(parsed.group);
    }

    const chatId = ctx.chatId || 'default';

    // Phase D — pending command-character post: splice user images into matching post & flag for auto-reply
    // v0.14.29: 同回合附带 AI 输出的 inline COMMENT 标签作为 NPC 评论挂到主帖（消除以前
    // 异步二次调用 NPC 评论概率失败的问题）。若 AI 没吐评论才退回到异步 fallback。
    const triggerInfos = []; // [{platform, postId, inlineComments}] for auto-reply after dispatch
    if (pendingPostCommand) {
        const cmd = pendingPostCommand;
        let arr, label;
        if (cmd.platform === '朋友圈') { arr = parsed.moments; label = '朋友圈'; }
        else if (cmd.platform === '论坛')   { arr = parsed.forum;   label = '论坛'; }
        else if (cmd.platform === '小红书') { arr = parsed.xhs;     label = '小红书'; }
        if (arr && arr.length) {
            // Fuzzy match — AI may drop title suffix etc. ("沈清瑶·仙盟盟主" → "沈清瑶")
            const target = cmd.targetName || '';
            let pIdx = arr.findIndex((p) => p.from === target);
            if (pIdx === -1) pIdx = arr.findIndex((p) => p.from && (target.includes(p.from) || p.from.includes(target)));
            // Last resort: take the first post (AI emitted exactly one post for our command)
            if (pIdx === -1 && arr.length === 1) pIdx = 0;
            if (pIdx !== -1) {
                const post = arr[pIdx];
                post.images = [...cmd.imageUrls];
                post.pic = null;             // strict: only user-attached images
                post.commandedByUser = true;  // marker for source flag in renderer
                post.from = cmd.targetName;   // normalize FROM back to full contact name
                if ('author' in post) post.author = cmd.targetName;
                if ('user' in post) post.user = cmd.targetName;

                // v0.14.29 inline COMMENT → 转换成 platform-native 格式挂到 post
                const inlineComments = (parsed.comments || []).filter(c => {
                    // 过滤掉 FROM 是 user / 主帖作者自己的 / 空内容的评论
                    if (!c.content || !c.from) return false;
                    if (c.from === cmd.targetName || c.from === 'user') return false;
                    return true;
                });
                if (inlineComments.length > 0) {
                    if (cmd.platform === '论坛') {
                        // forum 用 replies 字段 + author / content / time
                        post.replies = inlineComments.map((c, i) => ({
                            id: `reply_inline_${Date.now()}_${i}`,
                            from: c.from,
                            author: c.from,
                            content: c.content,
                            replyTo: c.replyTo || null,
                            time: c.time || cmd.time,
                        }));
                    } else {
                        // moments / xhs 用 comments 字段 + authorName / content / time
                        post.comments = inlineComments.map((c, i) => ({
                            id: `cmt_inline_${Date.now()}_${i}`,
                            from: c.from,
                            authorName: c.from,
                            content: c.content,
                            replyTo: c.replyTo || null,
                            time: c.time || cmd.time,
                        }));
                    }
                }

                triggerInfos.push({ platform: label, postId: post.id, inlineCount: inlineComments.length });
                pendingPostCommand = null;
            }
        }
    }

    // v0.14.43 AI 回复返回 → 清空 NPC 排除名单（已经用过一次）
    if (window.__smartPhone_rerollExcludeNpcs && window.__smartPhone_rerollExcludeNpcs.size > 0) {
        console.log(`[smart-phone v0.14.43] 清空 NPC 排除名单：${[...window.__smartPhone_rerollExcludeNpcs].join(', ')}`);
        window.__smartPhone_rerollExcludeNpcs.clear();
    }

    // v0.14.41 NPC_PROFILE 标签处理（在 SMS/GMSG 之前先存 strangerAnchor，
    // 这样后续 SMS 的 SUBJECT="X" 路由解析能找到 X 的 anchor）
    // v0.14.42 升级：必填字段校验 + toast 通知 + 跨重名检测
    const savedNpcNames = []; // 本回合保存的新 NPC 名（用于后续 toast）
    if (parsed.npcProfiles?.length) {
        const existingContactNames = new Set(State.load().contacts.map(c => c.name));
        // 群成员名也排除
        const allMemberNames = new Set();
        for (const g of (State.load().groups || [])) {
            for (const m of (g.members || [])) {
                if (m.nameSnapshot) allMemberNames.add(m.nameSnapshot);
            }
        }
        for (const npc of parsed.npcProfiles) {
            if (existingContactNames.has(npc.name)) {
                console.warn(`[smart-phone v0.14.42] NPC_PROFILE "${npc.name}" 跟现有联系人重名，跳过`);
                toastr.warning(`AI 引入的 NPC「${npc.name}」跟现有联系人重名，已忽略人设`);
                continue;
            }
            if (allMemberNames.has(npc.name)) {
                console.warn(`[smart-phone v0.14.42] NPC_PROFILE "${npc.name}" 跟群成员重名，跳过`);
                toastr.warning(`AI 引入的 NPC「${npc.name}」跟群成员重名，已忽略人设`);
                continue;
            }
            // v0.14.42 必填字段校验
            if (!npc.validation?.valid) {
                console.warn(`[smart-phone v0.14.42] NPC_PROFILE "${npc.name}" 不合格：${(npc.validation?.missing || []).join(', ')}`);
                toastr.warning(`AI 引入的 NPC「${npc.name}」人设不完整（缺：${(npc.validation?.missing || []).join(', ')}），plugin 未保存。点 ↩ 重新生成可能修正。`, '', { timeOut: 8000 });
                continue;
            }
            if (!npc.coreBooru) {
                console.warn(`[smart-phone v0.14.42] NPC_PROFILE "${npc.name}" 缺外貌 booru，跳过`);
                toastr.warning(`AI 引入的 NPC「${npc.name}」缺外貌 booru，下次出现会换样。点 ↩ 重新生成可能修正。`);
                continue;
            }
            State.saveStrangerAnchor(chatId, npc.name, {
                kind: npc.kind,
                core: npc.coreBooru,
                profile: npc.profile,
                worldbook: npc.worldbook,
                picTagSource: npc.profile.slice(0, 200),
            });
            savedNpcNames.push(npc.name);
            console.log(`[smart-phone v0.14.42] NPC_PROFILE 已缓存: ${npc.name} (${npc.kind})`);
        }
        // 汇总 toast
        if (savedNpcNames.length > 0) {
            toastr.success(
                `🆕 AI 引入了 ${savedNpcNames.length} 个新 NPC：${savedNpcNames.join('、')}\n（已缓存外貌锚 + 完整人设）`,
                '新 NPC 出现',
                { timeOut: 6000 },
            );
        }
    }

    // v0.14.42 检测"AI 用了 SUBJECT 但没输 NPC_PROFILE"的情况
    // 即 SMS/GMSG 的 SUBJECT="X" 但 X 不在联系人 / 不在群成员 / 不在本回合 NPC_PROFILE
    if (parsed.sms?.length || parsed.group?.length) {
        const knownNames = new Set([
            ...State.load().contacts.map(c => c.name),
            ...savedNpcNames,
            ...((State.load().groups || []).flatMap(g => (g.members || []).map(m => m.nameSnapshot))),
        ]);
        // 也容忍 strangerAnchor 里已存的（之前回合的）
        for (const sa of State.listStrangerAnchors(chatId)) knownNames.add(sa.name);
        const orphanSubjects = new Set();
        for (const item of [...(parsed.sms || []), ...(parsed.group || [])]) {
            if (item.subject && !knownNames.has(item.subject)) {
                orphanSubjects.add(item.subject);
            }
        }
        if (orphanSubjects.size > 0) {
            const names = [...orphanSubjects].join('、');
            toastr.warning(
                `AI 用 SUBJECT="${names}" 但没输 NPC_PROFILE 提供该 NPC 人设。图会出但视觉锚无法保存，下次出现会变样。建议点 ↩ 重新生成。`,
                'NPC 人设缺失',
                { timeOut: 8000 },
            );
            console.warn(`[smart-phone v0.14.42] orphan SUBJECT: ${[...orphanSubjects].join(', ')} — 无对应 NPC_PROFILE`);
        }
    }

    // v0.14.48 ⭐ 自动关联新 NPC_PROFILE 跟同回合的"无 SUBJECT pic SMS"
    // 场景：AI 介绍新 NPC 时写了 <NPC_PROFILE name="柳寒烟"...> + 一条来自联系人(岳清霜)的 SMS
    // 含 <pic> 但忘了写 SUBJECT="柳寒烟" → 默认按 FROM=岳清霜 路由 → 图用了 岳清霜 anchor
    // 修法：找无 subject 且 from != 新 NPC 的 SMS pic，按顺序赋值给同回合的 savedNpcNames
    if (savedNpcNames.length > 0 && parsed.sms?.length) {
        const candidates = parsed.sms.filter(s =>
            s.pic && !s.subject && !savedNpcNames.includes(s.from)
        );
        for (let i = 0; i < Math.min(candidates.length, savedNpcNames.length); i++) {
            candidates[i].subject = savedNpcNames[i];
            console.log(`[smart-phone v0.14.48] 自动关联 SMS pic → SUBJECT="${savedNpcNames[i]}"（AI 忘写 SUBJECT 时兜底）`);
        }
        // 群聊同处理
        if (parsed.group?.length) {
            const gcandidates = parsed.group.filter(g =>
                g.pic && !g.subject && !savedNpcNames.includes(g.from)
            );
            // 群聊 candidate 是 fallback 接下一批 — 从 candidates.length 开始
            const offset = Math.min(candidates.length, savedNpcNames.length);
            for (let i = 0; i < Math.min(gcandidates.length, savedNpcNames.length - offset); i++) {
                gcandidates[i].subject = savedNpcNames[offset + i];
                console.log(`[smart-phone v0.14.48] 自动关联 GMSG pic → SUBJECT="${savedNpcNames[offset + i]}"`);
            }
        }
    }

    // v0.14.49 ⭐ Pass 2 — 检测 <pic/> 占位符 + 后台 quiet AI 生成 booru prompt 填回
    // 仅在 settings.imageGen.splitPicGen 开启时启用
    if (s.imageGen?.splitPicGen) {
        await fillPlaceholderPicsViaPass2(parsed, chatId, _userText);
    }

    // v0.14.59 ⭐⭐⭐ pre-fire 对齐 — 把 GENERATION_STARTED 时启动的 ComfyUI Promise<URL>
    // 按 AI 写的 pic 顺序写入 picUrlCache[picTag]。render 时 triggerPicSlots 读 slot.dataset.pic
    // → 同 key cache 命中 → 直接 await Promise（已 resolved 就秒出图）
    if (_prefireState.active && _prefireState.urlPromises.length > 0) {
        const picRefs = [];
        const collectPic = (arr) => {
            if (!Array.isArray(arr)) return;
            for (const m of arr) {
                if (m.pic && typeof m.pic === 'string') picRefs.push(m);
            }
        };
        collectPic(parsed.sms);
        collectPic(parsed.group);
        collectPic(parsed.moments);
        const alignCount = Math.min(picRefs.length, _prefireState.urlPromises.length);
        for (let i = 0; i < alignCount; i++) {
            const ref = picRefs[i];
            const urlPromise = _prefireState.urlPromises[i];
            if (!ref.pic || !urlPromise) continue;
            // 把 Promise<URL> 存进 cache。triggerPicSlots line 3177 会 await 同一 Promise
            // 不重复 fire ComfyUI。.then 链同步在 cache 里把 Promise 替换成 URL（持久化也走那儿）
            picUrlCache.set(ref.pic, urlPromise);
            const picTagForClosure = ref.pic;
            urlPromise.then((url) => {
                if (!url) {
                    picUrlCache.delete(picTagForClosure);
                    return;
                }
                picUrlCache.set(picTagForClosure, url);
                try {
                    if (url) State.setPicUrl(chatId, picTagForClosure, url);
                } catch {}
            }).catch(() => { picUrlCache.delete(picTagForClosure); });
        }
        console.log(`[smart-phone v0.14.59] pre-fire 对齐：${alignCount}/${picRefs.length} 张图复用预生成结果，${picRefs.length - alignCount} 张走 fallback`);
        // 多余的 prefired Promise 丢弃（_resetPrefireState 在下一回合 GENERATION_STARTED 触发）
    }

    if (parsed.sms?.length) State.appendMessages(chatId, parsed.sms);
    if (parsed.moments?.length) State.appendMoments(chatId, parsed.moments);
    if (parsed.forum?.length) State.appendForum(chatId, parsed.forum);
    if (parsed.xhs?.length) State.appendXhs(chatId, parsed.xhs);
    // group / hongbao / voice currently routed into threads as well
    if (parsed.hongbao?.length) State.appendMessages(chatId, parsed.hongbao);
    if (parsed.voice?.length) State.appendMessages(chatId, parsed.voice);
    if (parsed.group?.length) {
        // v0.14.0 GMSG 路由：按 group name 模糊匹配现有 active group 的 id，写入 cs.groupThreads
        const allGroups = State.getActiveGroups();
        // 按 group name 分组（同一回合可能跨多个群，但通常 1 个）
        const byGroup = new Map();
        for (const g of parsed.group) {
            // 优先按当前打开的群 ID 路由（user 在群聊里发消息触发的 GMSG 都归到该群）
            let targetGroup = null;
            if (currentThread && isGroupThread(currentThread)) {
                targetGroup = State.findGroup(currentThread);
            }
            // fallback：按 GMSG.GROUP 属性精确/模糊匹配 active 群名
            if (!targetGroup && g.group) {
                targetGroup = allGroups.find(x => x.name === g.group)
                    || allGroups.find(x => x.name && (x.name.includes(g.group) || g.group.includes(x.name)));
            }
            if (!targetGroup) {
                console.warn('[smart-phone] GMSG 找不到对应群，丢弃:', g);
                continue;
            }
            // FROM 匹配：必须是该群成员（按 nameSnapshot 兜底匹配）
            const memberNames = (targetGroup.members || []).map(m => m.nameSnapshot);
            const isValidFrom = memberNames.includes(g.from)
                || memberNames.some(n => n.includes(g.from) || g.from.includes(n));
            if (!isValidFrom) {
                console.warn(`[smart-phone] GMSG FROM "${g.from}" 不在群 "${targetGroup.name}" 成员列表，丢弃`);
                continue;
            }
            const arr = byGroup.get(targetGroup.id) || [];
            arr.push({
                from: g.from,
                type: 'text',
                content: g.content,
                time: g.time,
                me: false,
                pic: g.pic,
                subjects: g.subjects, // 多角色合影时下游用
                subject: g.subject, // v0.14.41 单数 SUBJECT，A 发 B 照片时填 B
            });
            byGroup.set(targetGroup.id, arr);
        }
        // 批量写入各群
        for (const [gid, msgs] of byGroup) {
            State.appendGroupMessages(chatId, gid, msgs);
        }
    }

    // v0.14.29 After-dispatch: 只在 AI 没吐 inline COMMENT 时才走异步 fallback 二次调用
    // 若 inlineCount >= 2 → AI 已经把评论挂上了，跳过异步调用（消除概率失败）
    for (const info of triggerInfos) {
        if (info.inlineCount >= 2) {
            console.log(`[smart-phone] v0.14.29 inline ${info.inlineCount} comments attached to ${info.platform} post — skipping async fallback`);
            continue;
        }
        // AI 没吐评论或只吐了 1 条 → 走异步生成补足
        setTimeout(async () => {
            try {
                if (info.platform === '朋友圈') {
                    const post = State.findMomentsPost(chatId, info.postId);
                    const contacts = State.load().contacts.filter(c => !c.tempOrigin);
                    if (post) await generateMomentReplies(chatId, info.postId, post, contacts, ctx);
                } else if (info.platform === '论坛') {
                    const post = State.findForumPost(chatId, info.postId);
                    if (post) await generatePostReplies(chatId, info.postId, post, ctx);
                } else if (info.platform === '小红书') {
                    await generateStrangerComments(chatId, info.postId, ctx);
                }
                rerender();
            } catch (err) { console.error('[smart-phone] command-post auto-reply fallback failed:', err); }
        }, 600);
    }

    // v0.14.29 双模式 strip 策略：
    //   STRICT mode（user 点了手机 UI 按钮）→ 整条替换为 📱（PHONE 块已路由到 UI，prose 是泄漏）
    //   NORMAL mode（普通剧情）→ 仅剥 PHONE 块，保留 prose（AI 正常写的剧情）
    // v0.14.46 prose fallback 命中时强制走 📱（散文已被合成 SMS 进 UI，不留在 ST 主聊天）
    // v0.14.46 用 stripAllPhoneTags 替代 stripPhoneBlock — 同时清掉裸标签（lenient parser 路径）
    const stripped = Protocol.stripAllPhoneTags(msg.mes);
    if (stripped !== msg.mes || proseFallbackUsed) {
        msg.mes = (isStrictMode || proseFallbackUsed) ? '📱' : (stripped || '📱');
        try {
            const updateBlock = (await import('../../../../script.js')).updateMessageBlock;
            if (typeof updateBlock === 'function') updateBlock(idx, msg);
        } catch {}
        try { await ctx.saveChat(); } catch {}
    }

    // v0.14.46 prose fallback 用户提示 — 让 user 知道发生了什么（非阻塞 toast）
    if (proseFallbackUsed && typeof toastr !== 'undefined') {
        toastr.info('AI 这次写了散文而不是 PHONE 块，已自动转成短信进手机', null, { timeOut: 3500 });
    }

    rerender();
}

// ─────────────────────────────────────────────────────────────────────────
// SMS send: user → main chat textarea (mochi style)
// ─────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────
// Bubble inline edit (#1) — tap empty bubble → reveal pencil → tap pencil → edit
// ─────────────────────────────────────────────────────────────────────────
function wireBubbleEditing(screen) {
    // Click on bubble (without pic) toggles .bubble-active to reveal pencil.
    // Click on pencil enters edit mode. Click outside any bubble closes the active state.
    screen.querySelectorAll('.phone-bubble:not(.has-pic)').forEach((bubble) => {
        bubble.addEventListener('click', (e) => {
            // Ignore clicks on the pencil itself (pencil has its own handler below)
            if (e.target.closest('.bubble-edit-pencil')) return;
            if (e.target.closest('.bubble-edit-textarea, .bubble-edit-cancel, .bubble-edit-save')) return;
            // Already editing → ignore tap (use save/cancel buttons)
            if (bubble.classList.contains('bubble-editing')) return;
            // Toggle active state on this bubble; clear others
            const wasActive = bubble.classList.contains('bubble-active');
            screen.querySelectorAll('.phone-bubble.bubble-active').forEach((b) => b.classList.remove('bubble-active'));
            if (!wasActive) bubble.classList.add('bubble-active');
            e.stopPropagation();
        });
    });
    // Pencil click → enter edit mode
    screen.querySelectorAll('.bubble-edit-pencil').forEach((btn) => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const bubble = btn.closest('.phone-bubble');
            if (!bubble) return;
            enterBubbleEditMode(bubble);
        });
    });
    // Click outside any bubble closes the active state (one-time listener)
    if (screen._bubbleClickOutsideHooked) return;
    screen._bubbleClickOutsideHooked = true;
    screen.addEventListener('click', (e) => {
        if (!e.target.closest('.phone-bubble')) {
            screen.querySelectorAll('.phone-bubble.bubble-active').forEach((b) => b.classList.remove('bubble-active'));
        }
    });
}

function enterBubbleEditMode(bubble) {
    if (!bubble || bubble.classList.contains('bubble-editing')) return;
    const idxStr = bubble.dataset.msgIdx;
    const idx = parseInt(idxStr, 10);
    if (!Number.isInteger(idx)) return;
    if (!currentThread) return;

    const ctx = getContext();
    const cs = State.getChatState(ctx.chatId || 'default');
    const msg = cs.threads?.[currentThread]?.[idx];
    if (!msg) return;

    bubble.classList.add('bubble-editing');
    bubble.classList.remove('bubble-active');
    const original = msg.content || '';
    bubble.innerHTML = `
        <textarea class="bubble-edit-textarea" rows="3">${escapeHtml(original)}</textarea>
        <div class="bubble-edit-actions">
            <button class="bubble-edit-cancel">取消</button>
            <button class="bubble-edit-save">保存</button>
        </div>
    `;
    const ta = bubble.querySelector('.bubble-edit-textarea');
    ta?.focus();
    if (ta) ta.setSelectionRange(ta.value.length, ta.value.length);

    bubble.querySelector('.bubble-edit-cancel')?.addEventListener('click', (e) => {
        e.stopPropagation();
        rerender(); // discard, restore from state
    });
    bubble.querySelector('.bubble-edit-save')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const newContent = ta?.value?.trim() || '';
        if (newContent && newContent !== original) {
            msg.content = newContent;
            State.save();
        }
        rerender();
    });
}

async function handleSendSMS(text) {
    if (!text || !currentThread) return;
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    const time = Protocol.nowHHMM();

    // v0.14.0 群聊分支
    if (isGroupThread(currentThread)) {
        const group = State.findGroup(currentThread);
        if (!group) { toastr.error('群聊不存在'); return; }
        const members = State.resolveGroupMembers(group);
        const memberNames = members.map(m => m.nameSnapshot);

        // 1. push 用户消息到 groupThreads
        State.appendGroupMessages(chatId, currentThread, [{
            from: ctx.name1 || '我',
            type: 'text', content: text, time, me: true,
        }]);

        const input = phoneRoot?.querySelector('#phone-input');
        if (input) input.value = '';
        rerender();

        const ta = document.querySelector('#send_textarea');
        if (!ta) { toastr.error('找不到酒馆输入框'); return; }
        const ooc = Protocol.buildSendOOC({
            targetName: currentThread, time, userText: text,
            isGroup: true, groupName: group.name, memberNames,
        });
        const safeOoc = Protocol.makeRequestSafe(ooc);
        ta.value = `📱 <Request: ${safeOoc}>`;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('#send_but')?.click();
        return;
    }

    // 单聊原逻辑
    // v0.14.2 兜底：发消息时自动激活该 thread（保险，避免某些路径漏激活）
    State.activateChatThread(chatId, currentThread);
    State.appendMessages(chatId, [{
        from: currentThread,
        type: 'text',
        content: text,
        time,
        me: true,
    }]);

    const input = phoneRoot?.querySelector('#phone-input');
    if (input) input.value = '';
    rerender();

    const ta = document.querySelector('#send_textarea');
    if (!ta) { toastr.error('找不到酒馆输入框'); return; }
    // v0.14.34 透传当前联系人的视觉档案 anchor 给 AI（第 5.7 步外貌锚定铁律）
    const _targetContact = State.findContact(currentThread);
    const _targetAnchor = _targetContact?.anchor?.prompt || '';
    // v0.14.41 跨 thread 上下文 — 找其他联系人最近 24h 提到 currentThread 的对话注入 OOC
    const _crossThreadMentions = State.findCrossThreadMentions(chatId, currentThread, { hoursWindow: 24, perThreadMax: 3, totalMax: 8 });
    const ooc = Protocol.buildSendOOC({
        targetName: currentThread, time, userText: text, isGroup: false,
        targetAnchor: _targetAnchor,
        crossThreadMentions: _crossThreadMentions,
    });
    const safeOoc = Protocol.makeRequestSafe(ooc);
    ta.value = `📱 <Request: ${safeOoc}>`;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send_but')?.click();
}

// ─────────────────────────────────────────────────────────────────────────
// Reroll — remove last NPC message batch and trigger ST regenerate
// ─────────────────────────────────────────────────────────────────────────

async function handleReroll() {
    if (!currentThread) return;
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    // v0.14.44 群聊路径用 popLastGroupNpcBatch（之前误用 popLastNpcBatch 导致总报"没有可重新生成的消息"）
    const isGroup = isGroupThread(currentThread);
    const removed = isGroup
        ? State.popLastGroupNpcBatch(chatId, currentThread)
        : State.popLastNpcBatch(chatId, currentThread);
    if (!removed.length) { toastr.warning('没有可重新生成的消息'); return; }
    // v0.14.47 一并清掉持久化的 picUrls — 不然下次再 render 旧 picTag 还会用旧 URL
    const removedPics = removed.filter(m => m.pic).map(m => m.pic);
    for (const tag of removedPics) picUrlCache.delete(tag);
    State.deletePicUrlsBatch(chatId, removedPics);
    rerender();
    try {
        const { Generate, is_send_press } = await import('../../../../script.js');
        if (is_send_press) { toastr.warning('正在生成中，请稍候'); return; }
        Generate('regenerate');
    } catch (err) {
        console.error('[smart-phone] reroll failed:', err);
        toastr.error('重新生成失败');
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 朋友圈 (Moments)
// ─────────────────────────────────────────────────────────────────────────

async function handleMomentsClear() {
    const ctx = getContext();
    State.clearMoments(ctx.chatId || 'default');
    rerender();
    await handleMomentsRefresh();
}

// v0.14.28 设置页 🔄 按钮：重新扫激活世界书 + 比对 sourceHash 自动 resync 联系人。
// 用户重新导入修改过的卡 / 直接编辑 worldbook 条目后，点这个就刷新 anchor.prompt / note。
// anchor.locked=true 的联系人 anchor.prompt 不会被覆盖（用户锁定优先）。
// anchor.referenceImage / seed 永远不动。
// 老数据（0.14.27 之前）首次扫描仅 backfill sourceHash，不动 anchor.prompt 防止覆盖用户手编。
async function handleSettingsRefresh() {
    toastr.info('扫描世界书 + 同步联系人…');
    try {
        const result = await State.resyncContacts(WB.resyncContactsFromActiveBooks);
        const { backfilled, updated, unchanged, missing } = result;
        const parts = [];
        if (updated > 0) parts.push(`✅ ${updated} 条更新（条目内容变更）`);
        if (backfilled > 0) parts.push(`📌 ${backfilled} 条首次记录 hash（老数据，未动外貌）`);
        if (unchanged > 0) parts.push(`${unchanged} 未变`);
        if (missing > 0) parts.push(`⚠ ${missing} 条目在激活世界书中找不到`);
        const msg = parts.length ? parts.join('，') : '无可同步的联系人';
        if (updated > 0) toastr.success(msg);
        else if (missing > 0) toastr.warning(msg);
        else toastr.info(msg);
    } catch (e) {
        console.warn('[smart-phone] resync failed:', e);
        toastr.error('同步失败，看 console');
    }
    rerender();
}

async function handleMomentsRefresh() {
    // v0.14.10 fresh feed 排除 tempOrigin: true 联系人 (升级自陌生人的临时 NPC 不主动发朋友圈)
    const contacts = State.load().contacts.filter(c => !c.tempOrigin);
    if (!contacts.length) { toastr.warning('请先在设置中导入联系人'); return; }
    toastr.info('生成朋友圈动态…');
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    // v0.14.27 自动跟随当前激活世界书：filter stale + fallback 抽 lore
    const worldCtxEntries = await WB.getEffectiveWorldContextEntries(State.getWorldContext());
    const worldContextText = worldCtxEntries.length ? await WB.fetchWorldContextText(worldCtxEntries, { maxCharsPerEntry: 800 }) : '';
    const posts = await generateContactMoments(chatId, contacts, ctx, worldContextText);
    if (posts.length) { toastr.success(`新增 ${posts.length} 条动态`); rerender(); }
    else toastr.warning('生成失败（检查手机 API 配置）');
}

async function handleMomentsSubmit({ content, images = [] }) {
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    const userName = ctx?.name1 || '我';
    const now = new Date();
    const post = {
        id: `moment_user_${Date.now()}`,
        from: 'user',
        authorName: userName,
        content,
        pic: null,
        images: images.length ? [...images] : undefined,
        location: null,
        likes: 0,
        likedByUser: false,
        comments: [],
        time: Protocol.nowHHMM(),
        date: `${now.getMonth() + 1}-${now.getDate()}`,
    };
    State.appendMoments(chatId, [post]);
    momentsSetView('feed');
    rerender();
    // v0.14.10 排除 tempOrigin 联系人
    const contacts = State.load().contacts.filter(c => !c.tempOrigin);
    if (contacts.length) {
        toastr.info('等待联系人评论…');
        setTimeout(async () => {
            const ok = await generateMomentReplies(chatId, post.id, post, contacts, ctx);
            if (ok) { toastr.success('收到评论'); rerender(); }
        }, 500);
    }
}

function handleMomentsLike(postId) {
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    State.toggleMomentsLike(chatId, postId);
    rerender();
}

async function handleMomentsComment(postId, text) {
    if (!postId || !text) return;
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    const userName = ctx?.name1 || '我';
    State.appendMomentsComment(chatId, postId, [{ from: 'user', authorName: userName, content: text, time: Protocol.nowHHMM() }]);
    rerender();
    // v0.14.10 排除 tempOrigin 联系人
    const contacts = State.load().contacts.filter(c => !c.tempOrigin);
    if (contacts.length) {
        setTimeout(async () => {
            const post = State.findMomentsPost(chatId, postId);
            const ok = await generateMomentReplies(chatId, postId, post, contacts, ctx);
            if (ok) rerender();
        }, 500);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// 论坛 (贴吧)
// ─────────────────────────────────────────────────────────────────────────

async function handleForumClear() {
    const ctx = getContext();
    State.clearForum(ctx.chatId || 'default');
    rerender();
    await handleForumRefresh();
}

async function handleForumRefresh() {
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    toastr.info('生成新帖子…');
    // v0.14.27 自动跟随当前激活世界书：filter stale + fallback 抽 lore
    const worldCtxEntries = await WB.getEffectiveWorldContextEntries(State.getWorldContext());
    let worldContextText = '';
    if (worldCtxEntries.length) worldContextText = await WB.fetchWorldContextText(worldCtxEntries, { maxCharsPerEntry: 800 });
    const posts = await generateFreshPosts(chatId, ctx, worldContextText);
    if (posts.length) { toastr.success(`新增 ${posts.length} 条帖子`); rerender(); }
    else toastr.warning('生成失败（检查手机 API 配置）');
}

async function handleForumSubmit({ title, content, board, images = [] }) {
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    const userName = ctx?.name1 || '我';
    const time = Protocol.nowHHMM();
    const now = new Date();
    const dateStr = `${now.getMonth() + 1}-${now.getDate()}`;
    const post = {
        id: `tb_user_${Date.now()}`,
        from: 'user',
        board,
        author: userName,
        title,
        content,
        pic: null,
        images: images.length ? [...images] : undefined,
        likes: 0,
        replies: [],
        time,
        date: dateStr,
    };
    State.appendForum(chatId, [post]);
    forumSetView('detail', post.id);
    rerender();
    toastr.info('正在生成网友回复…');
    setTimeout(async () => {
        const ok = await generatePostReplies(chatId, post.id, post, ctx);
        if (ok) { toastr.success('回复已更新'); rerender(); }
        else toastr.warning('未生成回复（检查手机 API 配置）');
    }, 500);
}

async function handleForumReply(postId, text) {
    if (!postId || !text) return;
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    const userName = ctx?.name1 || '我';
    const time = Protocol.nowHHMM();
    State.appendForumReplies(chatId, postId, [{ from: 'user', author: userName, content: text, time }]);
    rerender();
    setTimeout(async () => {
        const post = State.findForumPost(chatId, postId);
        const ok = await generatePostReplies(chatId, postId, post, ctx);
        if (ok) rerender();
    }, 500);
}

// ─────────────────────────────────────────────────────────────────────────
// XHS (小红书)
// ─────────────────────────────────────────────────────────────────────────

async function handleXhsSubmit({ title, body, tag, images = [] }) {
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    const userName = ctx?.name1 || '我';
    const time = Protocol.nowHHMM();
    const now = new Date();
    const dateStr = `${now.getMonth() + 1}-${now.getDate()}`;
    const post = {
        id: `xhs_user_${Date.now()}`,
        from: 'user',
        user: userName,
        title: title || (body || '').slice(0, 20) + ((body || '').length > 20 ? '...' : ''),
        body: body || '',
        tag,
        pic: null,
        images: images.length ? [...images] : undefined,
        likes: Math.floor(Math.random() * 90000) + 10000,
        likedByUser: false,
        comments: [],
        time,
        date: dateStr,
    };
    State.appendXhs(chatId, [post]);
    xhsSetView('detail', post.id);
    rerender();

    toastr.info('正在生成网友评论…');
    setTimeout(async () => {
        const ok = await generateStrangerComments(chatId, post.id, ctx);
        if (ok) {
            toastr.success('评论已更新');
            rerender();
        } else {
            toastr.warning('未生成评论（检查手机 API 配置）');
        }
    }, 500);
}

async function handleXhsClear() {
    const ctx = getContext();
    State.clearXhs(ctx.chatId || 'default');
    rerender();
    await handleXhsRefresh();
}

async function handleXhsRefresh() {
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    toastr.info('生成新帖子…');
    // v0.14.27 自动跟随当前激活世界书：filter stale + fallback 抽 lore
    const worldCtxEntries = await WB.getEffectiveWorldContextEntries(State.getWorldContext());
    const worldContextText = worldCtxEntries.length
        ? await WB.fetchWorldContextText(worldCtxEntries, { maxCharsPerEntry: 800 })
        : '';
    const posts = await generateFreshFeed(chatId, ctx, worldContextText);
    if (posts.length) {
        toastr.success(`新增 ${posts.length} 条帖子`);
        rerender();
    } else {
        toastr.warning('生成失败（检查手机 API 配置）');
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Settings handlers
// ─────────────────────────────────────────────────────────────────────────

async function handleImportContact(uid, bookName) {
    let e = null;
    if (bookName) e = await WB.getEntryByUidInBook(uid, bookName);
    if (!e) {
        const entries = await WB.getActiveWorldbookEntries();
        e = entries.find((x) => x.uid === uid);
    }
    if (!e) return toastr.warning('找不到该条目');
    const fresh = entryToContact(e);
    // Preserve existing anchor + merge sourceBook arrays (don't reset reference image / seed on re-import)
    const existing = State.findContact(fresh.name);
    if (existing) {
        const oldSb = Array.isArray(existing.sourceBook) ? existing.sourceBook : (existing.sourceBook ? [existing.sourceBook] : []);
        const newSb = Array.isArray(fresh.sourceBook) ? fresh.sourceBook : (fresh.sourceBook ? [fresh.sourceBook] : []);
        const mergedSb = [...new Set([...oldSb, ...newSb])];
        // v0.14.28：
        // - 永远保留 anchor.referenceImage / seed / locked（用户人设图、用户锁定）
        // - anchor.prompt：未锁定时刷新为 fresh.anchor.prompt（用户主动 re-import 的意图就是要新值）
        // - sourceHash 同步到 fresh.sourceHash，避免之后 🔄 resync 重复触发覆盖
        const existingAnchor = existing.anchor || {};
        const updatedAnchor = existingAnchor.locked
            ? { ...existingAnchor }
            : { ...existingAnchor, prompt: (fresh.anchor.prompt && fresh.anchor.prompt.trim()) || existingAnchor.prompt };
        State.upsertContact({
            ...existing,
            rawContent: fresh.rawContent,
            note: fresh.note,
            bookName: fresh.bookName || existing.bookName,
            sourceBook: mergedSb,
            sourceHash: fresh.sourceHash,
            anchor: updatedAnchor,
        });
        toastr.success(`已更新：${fresh.name}（保留人设图，外貌 tag 已${existingAnchor.locked ? '锁定不变' : '同步'}）`);
    } else {
        State.upsertContact(fresh);
        toastr.success(`已导入：${fresh.name}`);
    }
    rerender();
}

async function handleGenRef(name, btn) {
    const c = State.findContact(name);
    if (!c) return;
    if (!window.smartImageGen?.generateReferenceImage) {
        return toastr.warning('请先安装并启用 smart-image-gen 扩展');
    }
    // Show loading state
    const origText = btn?.textContent || '生成参考图';
    if (btn) { btn.textContent = '⏳ 生成中…'; btn.disabled = true; }

    try {
        const { imageUrl, seed } = await window.smartImageGen.generateReferenceImage({
            characterName: name,
            anchorPrompt: c.anchor?.prompt || '',
            anchorSdPrompt: c.anchor?.sdPrompt || '',
            existingSeed: c.anchor?.locked ? c.anchor.seed : null,
        });
        if (!c.anchor) c.anchor = {};
        c.anchor.referenceImage = imageUrl;
        c.anchor.seed = seed;
        State.save();
        rerender();
        toastr.success(`${name} 参考图已生成 — 满意请点「✅ 保持」锁定外貌`);
    } catch (err) {
        console.error(err);
        toastr.error(`生成失败: ${err.message || err}`);
        if (btn) { btn.textContent = origText; btn.disabled = false; }
    }
}

function handlePromptEdit(name, prompt) {
    const c = State.findContact(name);
    if (!c) return;
    if (!c.anchor) c.anchor = {};
    c.anchor.prompt = prompt;
    State.save();
}

// v0.14.28 extractVisualProfile / buildAppearanceFromProfile 已移到 lib/worldbook.js
// （供 entryToContact 在 import 时 + resyncContactsFromActiveBooks 检测变更时复用）
async function handleGenerateAppearance(name, btn) {
    const c = State.findContact(name);
    if (!c?.rawContent) return toastr.warning('联系人没有世界书内容，无法生成外貌 tags');

    const origText = btn?.textContent || '✨';
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

    try {
        // === Phase 2: 优先尝试【视觉档案】表（确定性 + 零 API 消耗）===
        const profile = WB.extractVisualProfile(c.rawContent);
        if (profile) {
            const { appearance, full } = WB.buildAppearanceFromProfile(profile);
            if (!c.anchor) c.anchor = {};
            c.anchor.prompt = appearance;
            c.anchor.sdPrompt = full;
            State.save();
            const inp = phoneRoot?.querySelector(`.phone-contact-anchor-edit[data-name="${CSS.escape(name)}"]`);
            if (inp) inp.value = appearance;
            console.log(`[smart-phone] handleGenerateAppearance: 视觉档案表命中（${Object.keys(profile).length} 字段），跳过 DeepSeek`);
            toastr.success(`已从【视觉档案】表提取（${Object.keys(profile).length} 字段，未消耗 API）`);
            if (btn) { btn.textContent = origText; btn.disabled = false; }
            return;
        }

        // === fallback: DeepSeek 散文解析路径（兼容老卡片）===
        const s = State.load();
        const cfg = s.api || {};
        if (!cfg.url || !cfg.key) {
            if (btn) { btn.textContent = origText; btn.disabled = false; }
            return toastr.warning('请先在「设置 → 手机 API」填写 URL 和 Key');
        }

        const resp = await fetch(`${cfg.url.replace(/\/+$/, '')}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cfg.key}`,
            },
            body: JSON.stringify({
                model: cfg.model || 'deepseek-chat',
                messages: [
                    {
                        role: 'system',
                        content: `你是 SDXL / Danbooru tag 专家。把中文人设转成精准、紧凑的英文 booru tag。

**核心原则（违反 = 失败）**：
1. **总量控制**：APPEARANCE 严格在 **55-75 个 tag** 之间。SDXL token 上限 75 一段，超过会被切段稀释，过量 tag 反而互相打架，画质崩坏。
2. **不堆近义词**：每个特征**最多 2 个 tag**（1 主词 + 0-1 辅助）。要强调用加权 (tag:1.3)，**禁止**用 4-5 个近义词刷权重——模型会平均它们而不是叠加。
3. **不冲突**：不能同时写 "slender, curvy, voluptuous, hourglass" 这种互相矛盾的体型词，挑 1-2 个最准的。
4. **从原文出发**：原文没写就按世界观推断 1 个准确选项，**不要给 N 选 1 让模型猜**。

**严格输出格式**（只输出两行，无前后缀）：
APPEARANCE: [55-75 个英文 booru tag，逗号分隔]
FULL: [质量词前缀 + APPEARANCE 内容；禁场景/光照/构图/视角/画风词]

**FULL 内容白名单**（只能这两段）：
- 质量词前缀：masterpiece, best quality, highres, absurdres, intricate details
- APPEARANCE 全部 tag

**FULL 黑名单**（出现一个 = 不合格）：
- 背景：simple background / white background / studio / outdoor / indoor / scenery
- 光照：studio lighting / soft lighting / cinematic lighting / natural lighting
- 构图：upper body portrait / full body / looking at viewer / from above / close-up / 1girl / solo
- 画风：photorealistic / hyperrealistic / anime style / illustration / detailed skin / depth of field / sharp focus
- 理由：这些由帖子场景动态注入；FULL 只描人物本身，不锁场景/画风。

**七维度精简清单**（每维 N 个 tag，**严格遵守**）：

| 维度 | tag 数 | 写法 |
|------|--------|------|
| 1. 发型 | 5-8 | 1 颜色（加权 1.3）+ 1 长度 + 1 质感 + 1 造型 + 1-2 装饰 |
| 2. 眼睛 | 4-6 | 1 颜色（加权 1.3）+ 1 形状 + 1-2 修饰（long eyelashes 等）|
| 3. 肤色 | 2-3 | 1 主色（fair/pale/tan/dark skin）+ 1 强化（porcelain/smooth/healthy） |
| 4. 身材 | 12-18 | 1 身高 + 1 体型 + 胸（加权 1.3，1-2 词）+ 1 腰 + 1 臀 + 2-3 腿（**重点**）+ 1-2 其它 |
| 5. 脸型 | 4-6 | 1 脸型 + 1 颧骨/下巴 + 1 鼻 + 1 唇 + 1-2 妆 |
| 6. 服装 | 5-8 | 1 大类（hanfu/school uniform/business suit）+ 2-3 款式细节 + 1 材质 + 1-2 配饰 |
| 7. 气质/年龄 | 3-5 | 1 年龄 + 1 种族 + 1-2 气质 |

**身材腿型重点（用户特别要求）**：长腿/美腿务必写到，但精简：
- 长腿：long legs（可加权 1.2）
- 大腿（按设定选）：thick thighs / thigh gap / slim thighs（**只选一个**）
- 美感：beautiful legs（够了，不要再堆 smooth/shapely/model 等）

**加权规则**：
- 加权用 (tag:1.3)，**最多 4 个加权 tag**（建议：发色、眼睛、胸、长腿）
- 加权值范围 1.1-1.4，超出会过度
- **不**用近义词链刷权重（这是新手错误，效果反而差）

**Danbooru 标准**：只用标准 booru tag，禁止中式描述（"jade-like skin"/"gentle gaze"/"phoenix crown"）。原文没写就按世界观给 1 个最合理选项。

**禁止内容**：武器、职业技能、故事背景、心理性格词（"温柔/冷漠/坚强"）、动作动词、bgm。`,
                    },
                    {
                        role: 'user',
                        content: `示例 1 — 古风修仙女主（紫发凤眼大胸贵妃气质，肤色白皙，穿汉服丝绸）：

APPEARANCE: (dark purple hair:1.3), waist-length hair, silky hair, hair bun, jeweled hair ornament, hair stick, (purple eyes:1.3), almond eyes, long eyelashes, eyeliner, fair skin, porcelain skin, oval face, high cheekbones, delicate nose, thin lips, light makeup, tall female, hourglass figure, (huge breasts:1.3), narrow waist, wide hips, thick thighs, (long legs:1.2), beautiful legs, visible collarbones, hanfu, silk robes, wide sleeves, embroidered pattern, sash, jade pendant, mature female, east asian, elegant, regal
FULL: masterpiece, best quality, highres, absurdres, intricate details, (dark purple hair:1.3), waist-length hair, silky hair, hair bun, jeweled hair ornament, hair stick, (purple eyes:1.3), almond eyes, long eyelashes, eyeliner, fair skin, porcelain skin, oval face, high cheekbones, delicate nose, thin lips, light makeup, tall female, hourglass figure, (huge breasts:1.3), narrow waist, wide hips, thick thighs, (long legs:1.2), beautiful legs, visible collarbones, hanfu, silk robes, wide sleeves, embroidered pattern, sash, jade pendant, mature female, east asian, elegant, regal

示例 2 — 现代年轻女学生（浅紫长发凤眼活泼巨乳，肤色白嫩，穿校服）：

APPEARANCE: (lavender hair:1.3), long hair, wavy hair, side-swept hair, hair ribbon, (purple eyes:1.2), phoenix eyes, long eyelashes, sparkling eyes, fair skin, smooth skin, oval face, delicate nose, parted lips, lip gloss, blush, young adult, hourglass figure, (huge breasts:1.3), narrow waist, wide hips, thigh gap, (long legs:1.2), beautiful legs, visible collarbones, school uniform, sailor uniform, pleated skirt, neckerchief, knee-high socks, blazer, teen, east asian, cheerful, charming
FULL: masterpiece, best quality, highres, absurdres, intricate details, (lavender hair:1.3), long hair, wavy hair, side-swept hair, hair ribbon, (purple eyes:1.2), phoenix eyes, long eyelashes, sparkling eyes, fair skin, smooth skin, oval face, delicate nose, parted lips, lip gloss, blush, young adult, hourglass figure, (huge breasts:1.3), narrow waist, wide hips, thigh gap, (long legs:1.2), beautiful legs, visible collarbones, school uniform, sailor uniform, pleated skirt, neckerchief, knee-high socks, blazer, teen, east asian, cheerful, charming

—— 现在轮到你 ——

角色设定（中文）：

${c.rawContent}

按示例风格输出 APPEARANCE 和 FULL 两段：
- 总数 **55-75 个 tag**（数过，不能超 75）
- 每个特征 **1-2 个 tag**，**禁止**近义词链
- 加权 (tag:1.3) **最多 4 个**，建议加在：发色、眼睛颜色、胸、长腿
- 七维度都要覆盖（发型/眼睛/肤色/身材-腿/脸/服装/气质），但每维严格按上面的 tag 数表
- 原文没说的按世界观推断 1 个最准的，**不要 N 选 1**
- 体型词不冲突（不能同时 slender + curvy + voluptuous，挑 1 个最准的）`,
                    },
                ],
                temperature: 0.7,
                max_tokens: 32000,
            }),
        });

        if (!resp.ok) {
            const errBody = await resp.text().catch(() => '');
            throw new Error(`API ${resp.status}${errBody ? ': ' + errBody.slice(0, 120) : ''}`);
        }

        const data = await resp.json();
        console.log('[smart-phone] appearance API raw:', JSON.stringify(data).slice(0, 800));
        const msg = data?.choices?.[0]?.message || {};
        const finishReason = data?.choices?.[0]?.finish_reason || '';
        // DeepSeek-R1 puts reasoning in reasoning_content; content may be empty
        let result = (msg.content || msg.reasoning_content || '').trim();

        // Strip <think> / <thinking> blocks (DeepSeek-R1 etc.)
        result = result.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
        result = result.replace(/<think(?:ing)?>[\s\S]*$/gi, '').trim();
        // Strip leading non-tag characters (e.g. "以下是..." preamble)
        result = result.replace(/^[^a-zA-Z1-9(]+/, '').trim();

        if (!result) {
            throw new Error(`模型返回空内容 (finish_reason=${finishReason || '?'}) — 可能触发内容过滤，建议用 deepseek-chat`);
        }

        // Parse APPEARANCE / FULL sections
        const appearanceMatch = result.match(/APPEARANCE:\s*(.+?)(?=\nFULL:|$)/is);
        const fullMatch = result.match(/FULL:\s*(.+?)$/is);
        const appearanceTags = (appearanceMatch?.[1] || result).trim().replace(/^[^a-zA-Z1-9(]+/, '').trim();
        const fullPrompt = (fullMatch?.[1] || '').trim();

        if (!c.anchor) c.anchor = {};
        c.anchor.prompt = appearanceTags;
        if (fullPrompt) c.anchor.sdPrompt = fullPrompt;
        State.save();

        // Patch DOM directly — rerender would reset button text
        const inp = phoneRoot?.querySelector(`.phone-contact-anchor-edit[data-name="${CSS.escape(name)}"]`);
        if (inp) inp.value = appearanceTags;

        toastr.success(`外貌 tags 已生成${fullPrompt ? '（含完整 SD prompt）' : ''}，可手动微调后点「生成参考图」`);
    } catch (err) {
        console.error('[smart-phone] generateAppearance:', err);
        toastr.error(`生成失败: ${err.message || err}`);
    } finally {
        if (btn) { btn.textContent = origText; btn.disabled = false; }
    }
}

function handleLockRef(name) {
    const c = State.findContact(name);
    if (!c?.anchor) return;
    c.anchor.locked = !c.anchor.locked;
    State.save();
    rerender();
    toastr.info(c.anchor.locked ? `已锁定 ${name} 的外貌锚点` : `已解锁`);
}

function handleRemoveContact(name) {
    if (!confirm(`移除联系人 ${name}?`)) return;
    State.removeContact(name);
    rerender();
}

// ─────────────────────────────────────────────────────────────────────────
// World-book scoped contacts (v0.10.4) — handlers + modals
// ─────────────────────────────────────────────────────────────────────────

function handleShowAllContactsToggle(checked) {
    setShowAllContactsFlag(checked);
    rerender();
}

// Returns the union of all worldbook names that have ever been used by:
// - currently active books, contacts' sourceBook entries, world-context entries
// Used to populate world-book selector lists in modals.
function getKnownBookNames() {
    const set = new Set(getActiveBookNames());
    const s = State.load();
    for (const c of (s.contacts || [])) {
        const sb = Array.isArray(c.sourceBook) ? c.sourceBook : (c.sourceBook ? [c.sourceBook] : []);
        for (const b of sb) if (b) set.add(b);
        if (c.bookName) set.add(c.bookName);
    }
    for (const w of (s.worldContext || [])) {
        if (w.bookName) set.add(w.bookName);
    }
    return [...set];
}

// Modal opener — generic helper used by all v0.10.4 modals
function openContactsModal(title, bodyHtml, footerHtml) {
    if (document.getElementById('phone-contacts-modal')) return null;
    const modal = document.createElement('div');
    modal.id = 'phone-contacts-modal';
    modal.className = 'phone-forward-modal';
    modal.innerHTML = `
        <div class="phone-forward-card">
            <div class="phone-forward-header">
                <span>${escapeHtml(title)}</span>
                <button type="button" class="phone-forward-close" title="关闭">✕</button>
            </div>
            <div class="phone-forward-body">${bodyHtml}</div>
            <div class="phone-forward-footer">${footerHtml}</div>
        </div>
    `;
    (phoneRoot || document.body).appendChild(modal);
    modal.querySelector('.phone-forward-close')?.addEventListener('click', () => modal.remove());
    return modal;
}

// Batch-assign orphan contacts to worldbooks
function openBatchAssignOrphansModal() {
    const s = State.load();
    const { orphans } = partitionContacts(s.contacts, getActiveBookNames());
    if (orphans.length === 0) { toastr.info('没有未归属的联系人'); return; }
    const knownBooks = getKnownBookNames();
    if (knownBooks.length === 0) { toastr.warning('没有已知的世界书 — 先激活一本世界书'); return; }

    const rows = orphans.map((c) => `
        <div class="phone-orphan-row" data-name="${escapeHtml(c.name)}">
            <input type="checkbox" class="phone-orphan-check" data-name="${escapeHtml(c.name)}">
            <span class="phone-orphan-name">${escapeHtml(c.name)}</span>
            <select class="phone-orphan-select phone-select" data-name="${escapeHtml(c.name)}">
                <option value="">-- 不分配 --</option>
                ${knownBooks.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}
            </select>
        </div>
    `).join('');

    const body = `
        <p class="phone-settings-hint">勾选并选目的地世界书，可逐条不同选择，也可批量统一分配。</p>
        <div class="phone-orphan-list">${rows}</div>
        <div class="phone-orphan-batch">
            <label>批量统一：</label>
            <select id="phone-orphan-batch-select" class="phone-select">
                <option value="">-- 选择世界书 --</option>
                ${knownBooks.map((b) => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('')}
            </select>
            <button id="phone-orphan-batch-apply" class="phone-btn">应用到已勾选</button>
        </div>
    `;
    const footer = `
        <button type="button" class="phone-forward-cancel">取消</button>
        <button type="button" class="phone-forward-submit" id="phone-orphan-save">保存</button>
    `;
    const modal = openContactsModal('批量分配未归属联系人', body, footer);
    if (!modal) return;

    modal.querySelector('#phone-orphan-batch-apply')?.addEventListener('click', () => {
        const target = modal.querySelector('#phone-orphan-batch-select')?.value || '';
        if (!target) { toastr.warning('先选目标世界书'); return; }
        modal.querySelectorAll('.phone-orphan-check:checked').forEach((cb) => {
            const name = cb.dataset.name;
            const sel = modal.querySelector(`.phone-orphan-select[data-name="${CSS.escape(name)}"]`);
            if (sel) sel.value = target;
        });
    });

    modal.querySelector('.phone-forward-cancel')?.addEventListener('click', () => modal.remove());
    modal.querySelector('#phone-orphan-save')?.addEventListener('click', () => {
        const updates = [];
        modal.querySelectorAll('.phone-orphan-select').forEach((sel) => {
            const name = sel.dataset.name;
            const book = sel.value;
            if (book) updates.push({ name, book });
        });
        if (updates.length === 0) { toastr.info('未选择任何分配'); return; }
        const sNow = State.load();
        for (const u of updates) {
            const c = sNow.contacts.find((x) => x.name === u.name);
            if (!c) continue;
            const sb = Array.isArray(c.sourceBook) ? c.sourceBook : [];
            if (!sb.includes(u.book)) sb.push(u.book);
            c.sourceBook = sb;
            if (!c.bookName) c.bookName = u.book;
        }
        State.save();
        modal.remove();
        toastr.success(`已分配 ${updates.length} 个联系人`);
        rerender();
    });
}

// Delete all orphans (confirmed)
function handleDeleteAllOrphans() {
    const s = State.load();
    const { orphans } = partitionContacts(s.contacts, getActiveBookNames());
    if (orphans.length === 0) { toastr.info('没有未归属的联系人'); return; }
    if (!confirm(`确认删除全部 ${orphans.length} 个未归属联系人？\n此操作不可撤销，所有 anchor / 参考图都会丢失。`)) return;
    const orphanNames = new Set(orphans.map((c) => c.name));
    s.contacts = s.contacts.filter((c) => !orphanNames.has(c.name));
    State.save();
    toastr.success(`已删除 ${orphanNames.size} 个未归属联系人`);
    rerender();
}

// v0.14.25 chat-state 孤儿清理 modal
function openCleanupOrphanChatStatesModal() {
    const ctx = getContext();
    const currentChatId = ctx?.chatId || '';
    const list = State.listAllChatStates();
    if (list.length === 0) { toastr.info('没有任何 chat state 数据'); return; }

    const fmtSize = (n) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(2)} MB`;
    const totalBytes = list.reduce((a, x) => a + x.sizeBytes, 0);

    const rows = list.map((x) => {
        const isCurrent = x.chatId === currentChatId;
        const summary = `联系人 ${x.activeContacts} / 私聊 ${x.threadCount}（${x.messageCount} 条）/ 群聊 ${x.groupThreadCount}（${x.groupMessageCount} 条）/ 朋友圈 ${x.momentsCount} / 论坛 ${x.forumCount} / 小红书 ${x.xhsCount}`;
        return `
        <div class="phone-orphan-row" style="display:flex; align-items:flex-start; gap:8px; padding:6px 0; border-bottom:1px solid var(--SmartThemeBorderColor,#444);">
            <input type="checkbox" class="phone-cleanup-check" data-cid="${escapeHtml(x.chatId)}" ${isCurrent ? 'disabled' : ''}>
            <div style="flex:1; min-width:0;">
                <div style="font-weight:bold; word-break:break-all;">${escapeHtml(x.chatId)}${isCurrent ? ' <span style="color:#4a9;">（当前 chat）</span>' : ''}</div>
                <div style="font-size:11px; color:var(--SmartThemeQuoteColor,#888); margin-top:2px;">${escapeHtml(summary)}</div>
                <div style="font-size:11px; color:var(--SmartThemeQuoteColor,#888);">体积：${fmtSize(x.sizeBytes)}</div>
            </div>
        </div>`;
    }).join('');

    const body = `
        <p class="phone-settings-hint">
            共 ${list.length} 个 chat state，总体积 ${fmtSize(totalBytes)}。当前 chat 不能勾选（防误删）。<br>
            <strong>注意</strong>：本插件无法判断哪个 chat 是被酒馆删卡产生的孤儿——你**必须自己识别**哪些 chatId 已经不再用。删除后**不可恢复**（联系人/消息/朋友圈/论坛/小红书全删）。
        </p>
        <div style="margin:8px 0;">
            <button type="button" id="phone-cleanup-select-all" class="phone-btn">全选可删项</button>
            <button type="button" id="phone-cleanup-unselect-all" class="phone-btn">全不选</button>
        </div>
        <div style="max-height:50vh; overflow-y:auto;">${rows}</div>
    `;
    const footer = `
        <button type="button" class="phone-forward-cancel">取消</button>
        <button type="button" class="phone-forward-submit phone-btn-danger" id="phone-cleanup-confirm">删除已选</button>
    `;
    const modal = openContactsModal('🧹 chat state 清理', body, footer);
    if (!modal) return;

    modal.querySelector('#phone-cleanup-select-all')?.addEventListener('click', () => {
        modal.querySelectorAll('.phone-cleanup-check:not([disabled])').forEach((cb) => cb.checked = true);
    });
    modal.querySelector('#phone-cleanup-unselect-all')?.addEventListener('click', () => {
        modal.querySelectorAll('.phone-cleanup-check').forEach((cb) => cb.checked = false);
    });
    modal.querySelector('.phone-forward-cancel')?.addEventListener('click', () => modal.remove());
    modal.querySelector('#phone-cleanup-confirm')?.addEventListener('click', () => {
        const ids = [...modal.querySelectorAll('.phone-cleanup-check:checked')].map(cb => cb.dataset.cid);
        if (ids.length === 0) { toastr.info('未选任何项'); return; }
        if (!confirm(`确认删除 ${ids.length} 个 chat state？此操作不可恢复。`)) return;
        const removed = State.purgeChatStates(ids);
        toastr.success(`已删除 ${removed} 个 chat state`);
        modal.remove();
        rerender();
    });
}

// Cross-world import: select contacts from inactive worlds → add active worlds to their sourceBook
function openImportFromOtherWorldModal() {
    const activeBooks = getActiveBookNames();
    if (activeBooks.length === 0) { toastr.warning('当前没有激活的世界书'); return; }
    const s = State.load();
    const activeSet = new Set(activeBooks);
    // Candidates: contacts that DON'T overlap with any active book (i.e. live in some other world)
    const candidates = (s.contacts || []).filter((c) => {
        const sb = Array.isArray(c.sourceBook) ? c.sourceBook : (c.sourceBook ? [c.sourceBook] : []);
        if (sb.length === 0) return false; // orphans handled via batch-assign banner
        return !sb.some((b) => activeSet.has(b));
    });
    if (candidates.length === 0) { toastr.info('其他世界没有可引入的联系人'); return; }

    const rows = candidates.map((c) => {
        const sb = Array.isArray(c.sourceBook) ? c.sourceBook : (c.sourceBook ? [c.sourceBook] : []);
        return `
        <label class="phone-cw-row">
            <input type="checkbox" class="phone-cw-check" data-name="${escapeHtml(c.name)}">
            <span class="phone-cw-name">${escapeHtml(c.name)}</span>
            <span class="phone-cw-source">📖 ${escapeHtml(sb.join(' / '))}</span>
        </label>`;
    }).join('');

    const body = `
        <p class="phone-settings-hint">勾选要引入到当前世界（${escapeHtml(activeBooks.join(' / '))}）的联系人。anchor 数据共享，不会重新生成。</p>
        <div class="phone-cw-list">${rows}</div>
    `;
    const footer = `
        <button type="button" class="phone-forward-cancel">取消</button>
        <button type="button" class="phone-forward-submit" id="phone-cw-import">引入选中</button>
    `;
    const modal = openContactsModal('从其他世界引入联系人', body, footer);
    if (!modal) return;
    modal.querySelector('.phone-forward-cancel')?.addEventListener('click', () => modal.remove());
    modal.querySelector('#phone-cw-import')?.addEventListener('click', () => {
        const checked = [...modal.querySelectorAll('.phone-cw-check:checked')];
        if (checked.length === 0) { toastr.info('未选择任何联系人'); return; }
        const sNow = State.load();
        let count = 0;
        for (const cb of checked) {
            const name = cb.dataset.name;
            const c = sNow.contacts.find((x) => x.name === name);
            if (!c) continue;
            const sb = Array.isArray(c.sourceBook) ? c.sourceBook : (c.sourceBook ? [c.sourceBook] : []);
            for (const b of activeBooks) {
                if (!sb.includes(b)) sb.push(b);
            }
            c.sourceBook = sb;
            count++;
        }
        State.save();
        modal.remove();
        toastr.success(`已引入 ${count} 个联系人到当前世界`);
        rerender();
    });
}

// Per-contact source-book editor (📍 button on contact card)
function openEditContactSourceBookModal(name) {
    const s = State.load();
    const c = State.findContact(name);
    if (!c) { toastr.error('联系人不存在'); return; }
    const knownBooks = getKnownBookNames();
    const currentSb = Array.isArray(c.sourceBook) ? c.sourceBook : (c.sourceBook ? [c.sourceBook] : []);
    const currentSet = new Set(currentSb);

    if (knownBooks.length === 0) { toastr.warning('没有可选的世界书'); return; }

    const rows = knownBooks.map((b) => `
        <label class="phone-cw-row">
            <input type="checkbox" class="phone-edit-source-check" value="${escapeHtml(b)}" ${currentSet.has(b) ? 'checked' : ''}>
            <span class="phone-cw-name">${escapeHtml(b)}</span>
        </label>
    `).join('');

    const body = `
        <p class="phone-settings-hint"><strong>${escapeHtml(name)}</strong> 当前归属哪些世界书？勾选/取消后保存。</p>
        <div class="phone-cw-list">${rows}</div>
    `;
    const footer = `
        <button type="button" class="phone-forward-cancel">取消</button>
        <button type="button" class="phone-forward-submit" id="phone-edit-source-save">保存</button>
    `;
    const modal = openContactsModal(`改归属世界书 — ${name}`, body, footer);
    if (!modal) return;
    modal.querySelector('.phone-forward-cancel')?.addEventListener('click', () => modal.remove());
    modal.querySelector('#phone-edit-source-save')?.addEventListener('click', () => {
        const newSb = [...modal.querySelectorAll('.phone-edit-source-check:checked')].map((cb) => cb.value);
        c.sourceBook = newSb;
        if (!c.bookName && newSb[0]) c.bookName = newSb[0];
        State.save();
        modal.remove();
        toastr.success(`${name} 归属已更新`);
        rerender();
    });
}

function handleModelChange(model) { const s = State.load(); s.imageGen.currentModel = model; State.save(); toastr.success(`已切换到 ${model}`); }
function handleComfyuiUrlChange(url, isMobile = false) {
    const s = State.load();
    if (isMobile) s.imageGen.comfyuiUrlMobile = url;
    else s.imageGen.comfyuiUrl = url;
    State.save();
}

function getActiveComfyuiUrl() {
    const s = State.load();
    return (IS_TOUCH_DEVICE && s.imageGen.comfyuiUrlMobile) || s.imageGen.comfyuiUrl;
}

function handleToggleWorldContext({ uid, bookName, name }) {
    State.toggleWorldContext({ uid, bookName, name });
    rerender();
}

async function handleToggleLore(uid, bookName) {
    const s = State.load();
    const idx = s.worldbook.importedEntries.findIndex((e) => e.uid === uid && e.bookName === bookName);
    if (idx < 0) {
        const e = await WB.getEntryByUidInBook(uid, bookName);
        if (!e) return toastr.warning('找不到该条目');
        s.worldbook.importedEntries.push({
            uid: e.uid,
            bookName: bookName || '',
            name: e.comment || `entry-${uid}`,
            type: 'lore',
            enabled: true,
        });
        State.save();
        toastr.success(`已纳入：${e.comment || `entry-${uid}`}`);
    } else {
        s.worldbook.importedEntries[idx].enabled = !s.worldbook.importedEntries[idx].enabled;
        State.save();
    }
    rerender();
}

function handleApiSave(api) {
    const s = State.load();
    s.api = { ...(s.api || {}), ...api };
    State.save();
    toastr.success('API 配置已保存');
}

async function handleApiTest() {
    const s = State.load();
    if (!s.api?.url || !s.api?.key) return toastr.warning('请先填写 URL 和 Key');
    toastr.info('测试连接中…');
    try {
        const ok = await testPhoneApi();
        if (ok) toastr.success('✅ API 连接成功');
        else toastr.error('❌ API 测试失败（看控制台）');
    } catch (err) {
        toastr.error(`测试失败: ${err.message || err}`);
    }
}

async function handleFetchModels() {
    const s = State.load();
    if (!s.api?.url || !s.api?.key) {
        toastr.warning('请先填写 URL 和 Key');
        return [];
    }
    toastr.info('拉取模型列表…');
    try {
        const list = await fetchProviderModels();
        if (!list.length) toastr.warning('未拉到模型（可能服务器不支持 /models 端点）');
        return list;
    } catch (err) {
        toastr.error(`拉取失败: ${err.message || err}`);
        return [];
    }
}

async function handleComfyuiTest() {
    const url = getActiveComfyuiUrl();
    if (!url) return toastr.warning('请先填写 ComfyUI 地址');

    const cleanUrl = url.replace(/\/+$/, '');
    const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)\b/i.test(cleanUrl);
    const pageIsHttps = location.protocol === 'https:';
    const urlIsHttp = /^http:\/\//i.test(cleanUrl);

    // Pre-flight diagnostics — surface common failure modes before the actual fetch
    if (IS_TOUCH_DEVICE && isLoopback) {
        toastr.error(
            `❌ 手机端不能用 ${cleanUrl} —— 127.0.0.1/localhost 在手机上指向手机自己，不是运行 ComfyUI 的电脑。请在「📱 ComfyUI 地址（手机）」填电脑的局域网 IP，例如 http://192.168.1.x:8188`,
            '', { timeOut: 10_000, extendedTimeOut: 5_000 },
        );
        return;
    }
    if (pageIsHttps && urlIsHttp) {
        toastr.error(
            `❌ 当前页面 HTTPS，但 ComfyUI 是 HTTP（${cleanUrl}）—— 浏览器会拦截 mixed content。要么把酒馆改成 HTTP 访问，要么给 ComfyUI 套 HTTPS 反代。`,
            '', { timeOut: 10_000, extendedTimeOut: 5_000 },
        );
        return;
    }

    toastr.info(`测试 ComfyUI 连接：${cleanUrl}`);
    try {
        const resp = await fetch(`${cleanUrl}/system_stats`);
        if (!resp.ok) {
            toastr.error(`❌ ComfyUI 响应 ${resp.status}（${cleanUrl}）`);
            return;
        }
        const data = await resp.json();
        const ver = data?.system?.comfyui_version || data?.system?.python_version || 'unknown';
        toastr.success(`✅ ComfyUI 已连接 (${ver})`);
    } catch (err) {
        // Network failure — most common causes: ComfyUI 没开 / 没加 CORS / 没加 --listen / IP 过期 / 防火墙
        const hints = [
            `1) ComfyUI 是否启动且监听该地址？(netstat -an | findstr :8188 看是否 0.0.0.0:8188)`,
            `2) 启动参数是否含 --listen 0.0.0.0 --enable-cors-header *？`,
            `3) 电脑当前 IP 是否就是 ${cleanUrl.match(/\/\/([^:/]+)/)?.[1] || '?'}？(ipconfig 确认；DHCP 重连后 IP 常会变)`,
            `4) 电脑防火墙是否放行 8188 端口？`,
            IS_TOUCH_DEVICE ? `5) 手机和电脑是否在同一 Wi-Fi/局域网/热点？` : null,
        ].filter(Boolean).join('  ');
        toastr.error(
            `❌ 无法连接 ${cleanUrl}：${err.message || err}\n排查：${hints}`,
            '', { timeOut: 15_000, extendedTimeOut: 8_000 },
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Image slot dispatch
// ─────────────────────────────────────────────────────────────────────────

function openImageLightbox(src) {
    if (document.getElementById('sp-lightbox')) return;
    const overlay = document.createElement('div');
    overlay.id = 'sp-lightbox';
    // v0.14.8 fix（Android 单击放大不生效）：
    // ST 移动端给 <html> 加了 transform → <html> 成为 fixed 后代的 containing block，
    // 而 <html> 高度被坍塌成 0（同 fixMobileShellPos 处的注释）→ width/height: 100% 的
    // fixed overlay 会被解释成 0×0 完全看不见，看起来"点了没反应"。
    // 解法照搬 fixMobileShellPos：用 visualViewport 像素值显式撑开。
    const setOverlaySize = () => {
        const vw = window.visualViewport ? window.visualViewport.width  : window.innerWidth;
        const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        overlay.style.setProperty('width',  vw + 'px', 'important');
        overlay.style.setProperty('height', vh + 'px', 'important');
    };
    overlay.setAttribute('style', [
        'position: fixed !important',
        'top: 0 !important', 'left: 0 !important',
        'background: rgba(0,0,0,0.92) !important',
        'z-index: 2147483645 !important',
        'display: flex !important',
        'align-items: center !important',
        'justify-content: center !important',
        'cursor: zoom-out !important',
        'touch-action: pinch-zoom !important',
    ].join('; '));
    setOverlaySize();
    const img = document.createElement('img');
    img.src = src;
    img.setAttribute('style', 'max-width:100%;max-height:100%;object-fit:contain;touch-action:pinch-zoom');
    overlay.appendChild(img);
    // 旋转 / 地址栏收起 / 软键盘弹出都会改 viewport，跟随更新尺寸
    const onResize = () => setOverlaySize();
    window.visualViewport?.addEventListener('resize', onResize);
    window.addEventListener('resize', onResize);
    overlay.addEventListener('click', () => {
        window.visualViewport?.removeEventListener('resize', onResize);
        window.removeEventListener('resize', onResize);
        overlay.remove();
    });
    (document.documentElement || document.body).appendChild(overlay);
}

// attachPicClick removed — click handling unified into phoneRoot delegation (see bindGlobalEventDelegation).
// applySelectionToResolvedCell — called after a phone-image-slot resolves to <img>, in case its URL
// is in the active selection set (selection survives slot re-render).
function applySelectionToResolvedCell(cell, url) {
    if (!cell || !url) return;
    if (selectionMode && selectedImageUrls.has(url)) {
        cell.classList.add('selected');
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Selection helpers — Phase B
// ─────────────────────────────────────────────────────────────────────────

function getImageUrlFromCell(cell) {
    if (!cell) return null;
    // Prefer resolved <img>.src; fall back to looking at slot's known cache by data-pic
    const img = cell.querySelector('img.phone-pic');
    if (img?.src) return img.src;
    const slot = cell.querySelector('.phone-image-slot');
    if (slot?.dataset?.pic) {
        const cached = picUrlCache.get(slot.dataset.pic);
        if (typeof cached === 'string') return cached;
    }
    return null;
}

function isInChatScope(el) {
    return !!el && !!el.closest && !!el.closest('#phone-thread-body');
}

function enterSelectionMode() {
    if (selectionMode) return;
    selectionMode = true;
    selectionScopeThread = currentThread;
    updateSelectionToolbar();
}

// Returns ordered list of resolved image URLs from current chat thread.
// Used by command-post modal's image picker (only resolved cache entries).
function getCurrentChatImageUrls() {
    if (!currentThread) return [];
    const ctx = getContext();
    const cs = State.getChatState(ctx.chatId || 'default');
    const msgs = cs.threads?.[currentThread] || [];
    const out = [];
    for (const m of msgs) {
        if (!m.pic) continue;
        const cached = picUrlCache.get(m.pic);
        if (typeof cached === 'string') out.push(cached);
    }
    return out;
}

function exitSelectionMode() {
    selectionMode = false;
    selectionScopeThread = null;
    selectedImageUrls.clear();
    // Strip .selected from all cells
    if (phoneRoot) phoneRoot.querySelectorAll('.phone-img-cell.selected').forEach((c) => c.classList.remove('selected'));
    updateSelectionToolbar();
}

function toggleSelection(url, cell) {
    if (!url) return;
    if (selectedImageUrls.has(url)) {
        selectedImageUrls.delete(url);
        if (cell) cell.classList.remove('selected');
    } else {
        selectedImageUrls.add(url);
        if (cell) cell.classList.add('selected');
    }
    if (selectedImageUrls.size === 0 && selectionMode) {
        // Don't auto-exit — user might want to re-tap. They cancel via ✕.
    }
    updateSelectionToolbar();
}

function updateSelectionToolbar() {
    if (!phoneRoot) return;
    const tb = phoneRoot.querySelector('#phone-selection-toolbar');
    if (!tb) return;
    tb.style.display = selectionMode ? 'flex' : 'none';
    const count = selectedImageUrls.size;
    const countEl = tb.querySelector('#phone-sel-count');
    if (countEl) countEl.textContent = `${count} 张已选`;
    tb.querySelectorAll('.phone-sel-action').forEach((b) => {
        b.disabled = count === 0;
    });
}

function reapplySelectionToVisibleCells() {
    if (!phoneRoot || !selectionMode) return;
    phoneRoot.querySelectorAll('.phone-img-cell').forEach((cell) => {
        const url = getImageUrlFromCell(cell);
        if (url && selectedImageUrls.has(url)) cell.classList.add('selected');
        else cell.classList.remove('selected');
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Global event delegation on phoneRoot — long-press + click for selection/lightbox
// Called once after phoneRoot is created (in injectPhoneShell).
// ─────────────────────────────────────────────────────────────────────────
function bindGlobalEventDelegation() {
    if (!phoneRoot) return;

    const startLongPress = (e, point) => {
        const cell = e.target.closest && e.target.closest('.phone-img-cell');
        if (!cell || !isInChatScope(cell)) return;
        // Don't start on reroll buttons
        if (e.target.closest && e.target.closest('.phone-img-reroll-btn')) return;
        lpStartXY = { x: point.clientX, y: point.clientY };
        lpCellWhileTimer = cell;
        // Visual feedback: cell shows "being pressed" state during 500ms wait
        cell.classList.add('phone-img-cell-pressing');
        if (lpTimer) clearTimeout(lpTimer);
        lpTimer = setTimeout(() => {
            const url = getImageUrlFromCell(lpCellWhileTimer);
            if (url) {
                if (!selectionMode) enterSelectionMode();
                toggleSelection(url, lpCellWhileTimer);
                suppressNextClick = true; // eat trailing click on touchend to avoid double-toggle
                // Haptic confirmation — Android Chrome supports navigator.vibrate
                try { navigator.vibrate && navigator.vibrate(50); } catch {}
            }
            if (lpCellWhileTimer) lpCellWhileTimer.classList.remove('phone-img-cell-pressing');
            lpTimer = null;
            lpCellWhileTimer = null;
        }, LP_DELAY_MS);
    };
    const moveLongPress = (point) => {
        if (!lpTimer || !lpStartXY) return;
        const dx = Math.abs(point.clientX - lpStartXY.x);
        const dy = Math.abs(point.clientY - lpStartXY.y);
        if (dx > LP_MOVE_CANCEL_PX || dy > LP_MOVE_CANCEL_PX) {
            clearTimeout(lpTimer);
            lpTimer = null;
            if (lpCellWhileTimer) lpCellWhileTimer.classList.remove('phone-img-cell-pressing');
            lpCellWhileTimer = null;
        }
    };
    const endLongPress = () => {
        if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
        if (lpCellWhileTimer) lpCellWhileTimer.classList.remove('phone-img-cell-pressing');
        lpCellWhileTimer = null;
    };

    phoneRoot.addEventListener('touchstart', (e) => { if (e.touches[0]) startLongPress(e, e.touches[0]); }, { passive: true });
    phoneRoot.addEventListener('touchmove',  (e) => { if (e.touches[0]) moveLongPress(e.touches[0]); }, { passive: true });
    phoneRoot.addEventListener('touchend',   () => endLongPress(),   { passive: true });
    phoneRoot.addEventListener('touchcancel',() => endLongPress(),   { passive: true });
    phoneRoot.addEventListener('mousedown',  (e) => startLongPress(e, e));
    phoneRoot.addEventListener('mousemove',  (e) => moveLongPress(e));
    phoneRoot.addEventListener('mouseup',    () => endLongPress());

    // Right-click on chat image → enter selection (desktop)
    phoneRoot.addEventListener('contextmenu', (e) => {
        const cell = e.target.closest && e.target.closest('.phone-img-cell');
        if (!cell || !isInChatScope(cell)) return;
        e.preventDefault();
        const url = getImageUrlFromCell(cell);
        if (!url) return;
        if (!selectionMode) enterSelectionMode();
        toggleSelection(url, cell);
    });

    // Click delegation: short tap ALWAYS opens lightbox (universal mobile expectation).
    // Selection management is only via long-press or 🗂 toolbar button.
    // v0.12.3: 旧逻辑"selectionMode + chat scope → toggle selection 而不开 lightbox"
    // 在手机上极易导致用户莫名进入 selection mode 后所有点击失效（toolbar 可能溢出屏幕看不到）。
    // 改成 tap 永远开图，长按管理选择。WeChat / Photos / Instagram 全部这套交互。
    //
    // v0.13.1: 取消"必须同时命中 .phone-img-cell + img.phone-pic"的双要求。
    // 原写法在两类场景下挂掉：
    //   - moments / forum / xhs 直接渲染 .phone-image-slot，没有 .phone-img-cell 包装 → 永远开不了图
    //   - messages 虽有 cell 包装，但 .phone-image-slot 有 12px padding，点到图片周围
    //     padding 时 e.target 是 slot 而非 img，closest('img.phone-pic') 拿不到 img（祖先链没有）
    // 新逻辑：找 img 优先；找不到就从最近的 slot/cell 里反向 querySelector 摸一张已加载的图。
    phoneRoot.addEventListener('click', (e) => {
        // Long-press fired moments ago — eat the trailing click so we don't toggle the same cell off
        if (suppressNextClick) {
            suppressNextClick = false;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        // v0.14.42 新 NPC chip 点击 → 弹升级 modal
        const npcChip = e.target.closest && e.target.closest('.phone-new-npc-chip');
        if (npcChip && npcChip.dataset.npcName) {
            e.preventDefault();
            e.stopPropagation();
            promoteStrangerHandler(npcChip.dataset.npcName);
            return;
        }
        // v0.14.43 换不同 NPC 按钮 → reroll regenerate with exclusion
        const npcReroll = e.target.closest && e.target.closest('.phone-new-npc-reroll');
        if (npcReroll && npcReroll.dataset.npcName) {
            e.preventDefault();
            e.stopPropagation();
            rerollAsDifferentNpcHandler(npcReroll.dataset.npcName);
            return;
        }
        // Reroll button has its own handler in rerender (with stopPropagation); skip here.
        if (e.target.closest && e.target.closest('.phone-img-reroll-btn')) return;
        let img = e.target.closest && e.target.closest('img.phone-pic');
        if (!img) {
            const slot = e.target.closest && e.target.closest('.phone-image-slot');
            if (slot) img = slot.querySelector('img.phone-pic');
        }
        if (!img) {
            const cell = e.target.closest && e.target.closest('.phone-img-cell');
            if (cell) img = cell.querySelector('img.phone-pic');
        }
        if (img && img.src) openImageLightbox(img.src);
    });

    // Selection toolbar controls
    phoneRoot.querySelector('#phone-sel-cancel')?.addEventListener('click', () => exitSelectionMode());
    phoneRoot.querySelectorAll('.phone-sel-action').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (selectedImageUrls.size === 0) return;
            const target = btn.dataset.target; // 'moments' / 'forum' / 'xhs'
            const urls = [...selectedImageUrls];
            openForwardModal(target, urls);
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Forward modal — Phase C
// User selected N images, picked target platform → modal shows preview grid +
// per-platform fields. On 发布: create user post with images attached, jump to feed.
// ─────────────────────────────────────────────────────────────────────────
function openForwardModal(target, initialImageUrls) {
    if (document.getElementById('phone-forward-modal')) return; // already open

    const titles = { moments: '转发到 朋友圈', forum: '转发到 论坛', xhs: '转发到 小红书' };
    const modal = document.createElement('div');
    modal.id = 'phone-forward-modal';
    modal.className = 'phone-forward-modal';

    // Local mutable copy of images so user can ✕ individuals in modal
    let modalImages = [...initialImageUrls];

    // Per-platform field HTML + state field IDs
    function fieldsHTML() {
        if (target === 'moments') {
            return `<textarea id="pf-content" class="pf-textarea" rows="4" maxlength="500" placeholder="这一刻的想法…"></textarea>`;
        }
        if (target === 'forum') {
            return `
                <input id="pf-title" class="pf-input" type="text" maxlength="40" placeholder="标题（必填）">
                <div id="pf-board-row" class="pf-chip-row">
                    ${FORUM_BOARDS.map((b, i) => `<button type="button" class="pf-chip${i === 5 ? ' selected' : ''}" data-board="${escapeHtml(b)}">${escapeHtml(b)}</button>`).join('')}
                </div>
                <textarea id="pf-content" class="pf-textarea" rows="4" maxlength="500" placeholder="正文…"></textarea>
            `;
        }
        // xhs
        return `
            <input id="pf-title" class="pf-input" type="text" maxlength="40" placeholder="标题（可选）">
            <textarea id="pf-content" class="pf-textarea" rows="4" maxlength="500" placeholder="正文…"></textarea>
            <div id="pf-tag-row" class="pf-chip-row">
                ${XHS_TAGS.map((t, i) => `<button type="button" class="pf-chip${i === 0 ? ' selected' : ''}" data-tag="${escapeHtml(t)}">#${escapeHtml(t)}</button>`).join('')}
            </div>
        `;
    }

    function imagesHTML() {
        return modalImages.map((url, i) => `
            <div class="pf-img-cell">
                <img src="${escapeHtml(url)}">
                <button type="button" class="pf-img-remove" data-idx="${i}" title="移除">✕</button>
            </div>
        `).join('');
    }

    modal.innerHTML = `
        <div class="phone-forward-card">
            <div class="phone-forward-header">
                <span>${titles[target] || '转发'}</span>
                <button type="button" class="phone-forward-close" title="关闭">✕</button>
            </div>
            <div class="phone-forward-body">
                <div id="pf-images" class="pf-images">${imagesHTML()}</div>
                <div class="phone-forward-fields">${fieldsHTML()}</div>
            </div>
            <div class="phone-forward-footer">
                <button type="button" class="phone-forward-cancel">取消</button>
                <button type="button" class="phone-forward-submit">发布</button>
            </div>
        </div>
    `;
    (phoneRoot || document.body).appendChild(modal);

    function close() { modal.remove(); }

    function rerenderImages() {
        const container = modal.querySelector('#pf-images');
        if (!container) return;
        container.innerHTML = imagesHTML();
        wireImageRemoveButtons();
    }

    function wireImageRemoveButtons() {
        modal.querySelectorAll('.pf-img-remove').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt(btn.dataset.idx, 10);
                if (Number.isInteger(idx)) {
                    modalImages.splice(idx, 1);
                    if (modalImages.length === 0) {
                        toastr.warning('图片为空');
                        close();
                        return;
                    }
                    rerenderImages();
                }
            });
        });
    }
    wireImageRemoveButtons();

    // Chip selectors (board / tag)
    modal.querySelectorAll('.pf-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            modal.querySelectorAll('.pf-chip').forEach((c) => c.classList.remove('selected'));
            chip.classList.add('selected');
        });
    });

    modal.querySelector('.phone-forward-close')?.addEventListener('click', close);
    modal.querySelector('.phone-forward-cancel')?.addEventListener('click', close);

    modal.querySelector('.phone-forward-submit')?.addEventListener('click', async () => {
        const content = modal.querySelector('#pf-content')?.value?.trim() || '';
        const title = modal.querySelector('#pf-title')?.value?.trim() || '';

        if (target === 'moments') {
            // Caption optional; allow empty caption with images
            await handleMomentsSubmit({ content, images: modalImages });
        } else if (target === 'forum') {
            if (!title) { toastr.warning('请填写标题'); return; }
            const board = modal.querySelector('#pf-board-row .pf-chip.selected')?.dataset.board || '日常吧';
            await handleForumSubmit({ title, content, board, images: modalImages });
        } else if (target === 'xhs') {
            const tag = modal.querySelector('#pf-tag-row .pf-chip.selected')?.dataset.tag || '日常';
            await handleXhsSubmit({ title, body: content, tag, images: modalImages });
        }

        close();
        exitSelectionMode();
        // Jump to target app
        currentApp = target;
        if (target === 'forum') forumSetView('feed');
        else if (target === 'xhs') xhsSetView('feed');
        else if (target === 'moments') momentsSetView('feed');
        rerender();
    });
}

// ─────────────────────────────────────────────────────────────────────────
// Command-character post modal — Phase D
// User picks platform + selects images from current chat + types instruction.
// Sends OOC to ST AI; pending state set for splice on AI response.
// ─────────────────────────────────────────────────────────────────────────
function openCommandPostModal(targetName) {
    if (document.getElementById('phone-cmdpost-modal')) return;

    const allChatImages = getCurrentChatImageUrls();
    let pickedImages = new Set(); // local selection state for this modal
    let selectedPlatform = '朋友圈';

    const modal = document.createElement('div');
    modal.id = 'phone-cmdpost-modal';
    modal.className = 'phone-forward-modal';

    function imagePickerHTML() {
        if (allChatImages.length === 0) {
            return `<div class="pf-cmd-empty">当前对话没有可选图片<br><small>先生成几张再来</small></div>`;
        }
        return `<div class="pf-cmd-image-grid">${allChatImages.map((url, i) => `
            <div class="pf-img-cell pf-cmd-img-cell${pickedImages.has(url) ? ' selected' : ''}" data-url="${escapeHtml(url)}">
                <img src="${escapeHtml(url)}">
            </div>
        `).join('')}</div>`;
    }

    function rerenderPicker() {
        const c = modal.querySelector('#pf-cmd-image-area');
        if (c) c.innerHTML = imagePickerHTML();
        wirePickerCells();
    }

    function wirePickerCells() {
        modal.querySelectorAll('.pf-cmd-img-cell').forEach((cell) => {
            cell.addEventListener('click', () => {
                const url = cell.dataset.url;
                if (!url) return;
                if (pickedImages.has(url)) {
                    pickedImages.delete(url);
                    cell.classList.remove('selected');
                } else {
                    pickedImages.add(url);
                    cell.classList.add('selected');
                }
            });
        });
    }

    modal.innerHTML = `
        <div class="phone-forward-card">
            <div class="phone-forward-header">
                <span>命令 ${escapeHtml(targetName)} 发帖</span>
                <button type="button" class="phone-forward-close" title="关闭">✕</button>
            </div>
            <div class="phone-forward-body">
                <div class="pf-cmd-platform-row">
                    <button type="button" class="pf-chip selected" data-platform="朋友圈">朋友圈</button>
                    <button type="button" class="pf-chip" data-platform="论坛">论坛</button>
                    <button type="button" class="pf-chip" data-platform="小红书">小红书</button>
                </div>
                <div class="pf-cmd-section-label">附图（点选；当前对话已生成的图片）</div>
                <div id="pf-cmd-image-area">${imagePickerHTML()}</div>
                <div class="pf-cmd-section-label">指令</div>
                <textarea id="pf-cmd-instruction" class="pf-textarea" rows="4" maxlength="500"
                    placeholder="例：写得轻佻一点，让所有人都看到你今天穿成什么样"></textarea>
            </div>
            <div class="phone-forward-footer">
                <button type="button" class="phone-forward-cancel">取消</button>
                <button type="button" class="phone-forward-submit">命令发送</button>
            </div>
        </div>
    `;
    (phoneRoot || document.body).appendChild(modal);

    function close() { modal.remove(); }

    wirePickerCells();

    // Platform chips
    modal.querySelectorAll('.pf-cmd-platform-row .pf-chip').forEach((chip) => {
        chip.addEventListener('click', () => {
            modal.querySelectorAll('.pf-cmd-platform-row .pf-chip').forEach((c) => c.classList.remove('selected'));
            chip.classList.add('selected');
            selectedPlatform = chip.dataset.platform;
        });
    });

    modal.querySelector('.phone-forward-close')?.addEventListener('click', close);
    modal.querySelector('.phone-forward-cancel')?.addEventListener('click', close);

    modal.querySelector('.phone-forward-submit')?.addEventListener('click', async () => {
        const instruction = modal.querySelector('#pf-cmd-instruction')?.value?.trim() || '';
        if (!instruction) { toastr.warning('请填写指令'); return; }
        const imageUrls = [...pickedImages];
        close();
        await submitCommandPost({ targetName, platform: selectedPlatform, instruction, imageUrls });
    });
}

async function submitCommandPost({ targetName, platform, instruction, imageUrls }) {
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    const time = Protocol.nowHHMM();

    // Visible bubble in chat showing what the user commanded
    State.appendMessages(chatId, [{
        from: targetName,
        type: 'text',
        content: `[命令她在${platform}发帖] ${instruction}${imageUrls.length ? `（附 ${imageUrls.length} 张图）` : ''}`,
        time,
        me: true,
    }]);
    rerender();

    // Set pending state so onMessageReceived will splice user images into the AI's post
    pendingPostCommand = { platform, targetName, time, imageUrls: [...imageUrls] };

    // Send OOC via ST input → main chat AI
    const ta = document.querySelector('#send_textarea');
    if (!ta) {
        toastr.error('找不到酒馆输入框');
        pendingPostCommand = null;
        return;
    }
    // v0.14.29 同回合 NPC 评论：把当前联系人池传给 OOC 让 AI 一次性生成主帖 + 3-6 条评论
    const allContacts = State.load().contacts.filter(c => !c.tempOrigin).map(c => c.name);
    const ooc = Protocol.buildPostCommandOOC({
        targetName, time, platform, instruction, imageCount: imageUrls.length,
        otherContactNames: allContacts,
    });
    const safeOoc = Protocol.makeRequestSafe(ooc);
    ta.value = `📱 <Request: ${safeOoc}>`;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send_but')?.click();
}

function triggerPicSlots(screen) {
    const slots = screen.querySelectorAll('.phone-image-slot[data-pic]:not([data-loaded])');
    if (!slots.length) return;
    if (!window.smartImageGen?.generateFromPicTag) return;

    slots.forEach(async (slot) => {
        slot.setAttribute('data-loaded', '1');
        const picTag = slot.dataset.pic;
        const hintName = slot.dataset.hint;
        const hintContext = slot.dataset.context || '';
        const hintSource = slot.dataset.source || '';
        // v0.14.0 多角色合影：dataset.subjects = "张三,李四,王五" 触发 generateGroupPicTag 路径
        const subjectsRaw = slot.dataset.subjects || '';
        const subjects = subjectsRaw ? subjectsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
        const isReroll = slot.dataset.reroll === '1';
        if (isReroll) slot.removeAttribute('data-reroll');

        // v0.14.0 fallback 修复：群聊时 currentThread 是 grp_xxx，不能用作 hint.from
        // 改为扫 picTag/context 找已知群成员名
        let fallbackFrom = null;
        if (!hintName && currentThread) {
            if (isGroupThread(currentThread)) {
                const group = State.findGroup(currentThread);
                if (group) {
                    const memberNames = (group.members || []).map(m => m.nameSnapshot);
                    fallbackFrom = memberNames.find(n => picTag.includes(n) || hintContext.includes(n));
                }
            } else {
                fallbackFrom = currentThread; // 单聊 fallback 不变
            }
        }
        const hint = hintName
            ? { from: hintName, context: hintContext, source: hintSource, reroll: isReroll }
            : (fallbackFrom ? { from: fallbackFrom, context: hintContext, source: hintSource, reroll: isReroll } : { context: hintContext, source: hintSource, reroll: isReroll });

        let cached = picUrlCache.get(picTag);

        // v0.14.47 内存 cache miss 时回查持久化 state（修"退出 ST 重进后图片重新生成"bug）
        if (!cached) {
            const _ctx = getContext();
            const _chatId = _ctx.chatId || 'default';
            const persisted = State.getPicUrl(_chatId, picTag);
            if (persisted) {
                cached = persisted;
                picUrlCache.set(picTag, persisted); // 顺便回填内存 cache 给后续 render 用
            }
        }

        // Already resolved — show immediately
        if (typeof cached === 'string') {
            slot.innerHTML = `<img src="${escapeHtml(cached)}" class="phone-pic">`;
            applySelectionToResolvedCell(slot.closest('.phone-img-cell'), cached);
            return;
        }

        // In-flight Promise — await the same request instead of firing a duplicate
        if (cached instanceof Promise) {
            try {
                const url = await cached;
                if (url) { slot.innerHTML = `<img src="${escapeHtml(url)}" class="phone-pic">`; applySelectionToResolvedCell(slot.closest('.phone-img-cell'), url); }
                else slot.textContent = '📷 生成失败';
            } catch (err) { slot.textContent = `📷 ${err.message || err}`; }
            return;
        }

        // v0.14.0 多角色合影路径：subjects.length > 1 走 generateGroupPicTag
        const useGroupPic = subjects.length > 1 && window.smartImageGen?.generateGroupPicTag;
        const generator = useGroupPic
            ? () => window.smartImageGen.generateGroupPicTag(picTag, {
                contacts: State.load().contacts,
                subjects, hint,
            })
            : () => window.smartImageGen.generateFromPicTag(picTag, {
                contacts: State.load().contacts,
                hint,
            });
        const promise = generator()
            .then((url) => {
                picUrlCache.set(picTag, url);
                // v0.14.47 持久化 URL 到 chat state，下次进 ST 不重新出图
                try {
                    const _ctx = getContext();
                    const _chatId = _ctx.chatId || 'default';
                    if (url) State.setPicUrl(_chatId, picTag, url);
                } catch {}
                return url;
            })
            .catch((err) => { picUrlCache.delete(picTag); throw err; });
        picUrlCache.set(picTag, promise);

        try {
            const url = await promise;
            if (url) {
                slot.innerHTML = `<img src="${escapeHtml(url)}" class="phone-pic">`;
                applySelectionToResolvedCell(slot.closest('.phone-img-cell'), url);
            } else slot.textContent = '📷 生成失败';
        } catch (err) {
            console.error(err);
            slot.textContent = `📷 ${err.message || err}`;
        }
    });
}

function rerollPicSlot(picTag) {
    picUrlCache.delete(picTag);
    // v0.14.47 一起清持久化 — 否则下次进 ST 还是旧 URL
    try {
        const _ctx = getContext();
        const _chatId = _ctx.chatId || 'default';
        State.deletePicUrl(_chatId, picTag);
    } catch {}
    const screen = phoneRoot?.querySelector('#smart-phone-screen');
    if (!screen) return;
    // Find the slot by its data-pic value, mark it for reroll, and reset so triggerPicSlots will re-process it.
    // The reroll flag tells generateFromPicTag to ignore the locked seed → produces a different image.
    screen.querySelectorAll('.phone-image-slot[data-pic]').forEach((slot) => {
        if (slot.dataset.pic === picTag) {
            slot.removeAttribute('data-loaded');
            slot.dataset.reroll = '1';
            slot.innerHTML = '📷 生成中…';
        }
    });
    triggerPicSlots(screen);
}

// Public API for image-gen extension
window.smartPhone = {
    getContacts: () => State.load().contacts,
    findContact: (name) => State.findContact(name),
    getCurrentModel: () => State.load().imageGen.currentModel,
    getComfyuiUrl: () => getActiveComfyuiUrl(),
    getWorkflowPath: (model) => State.load().imageGen.workflowPaths[model],
    // v0.14.0 暴露给 smart-image-gen 调群成员 anchor
    findContactById: (id) => State.findContactById(id),
    findGroup: (id) => State.findGroup(id),
    resolveGroupMembers: (group) => State.resolveGroupMembers(group),
    // v0.14.8 陌生人锚点 API（smart-image-gen 调用，chat-scoped）
    getStrangerAnchor: (chatId, name) => State.getStrangerAnchor(chatId, name),
    saveStrangerAnchor: (chatId, name, data) => State.saveStrangerAnchor(chatId, name, data),
    incrementStrangerAppearCount: (chatId, name) => State.incrementStrangerAppearCount(chatId, name),
    listStrangerAnchors: (chatId) => State.listStrangerAnchors(chatId),
    removeStrangerAnchor: (chatId, name) => State.removeStrangerAnchor(chatId, name),
};

// ─────────────────────────────────────────────────────────────────────────
// v0.14.0 群聊 modal handlers
// ─────────────────────────────────────────────────────────────────────────

// v0.14.4 modal 插入容器：限制在 .smart-phone-frame 里，配合 CSS position:absolute 不超出手机壳
function getModalContainer() {
    return phoneRoot?.querySelector('.smart-phone-frame') || phoneRoot;
}

// v0.14.2 长按/右键聊天列表项 → 弹删除该聊天菜单
function showChatDeleteMenu(threadId, isGroup, anchorEl) {
    if (!phoneRoot) return;
    const existing = phoneRoot.querySelector('#phone-chat-delete-menu');
    if (existing) existing.remove();
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';

    let label;
    if (isGroup) {
        const g = State.findGroup(threadId);
        if (!g) return;
        label = `「${g.name}」`;
    } else {
        label = `「${threadId}」`;
    }

    const html = `<div class="phone-modal-bg" id="phone-chat-delete-menu">
        <div class="phone-modal" style="max-width:320px;">
            <div class="phone-modal-hd">删除聊天</div>
            <div class="phone-modal-body">
                <p style="margin:8px 0;font-size:14px;color:#333;">确定删除聊天 ${escapeHtml(label)}？</p>
                <p style="margin:0;font-size:12px;color:#888;">${isGroup ? '群聊将进入软删除（30 天可恢复）' : '聊天记录会清空，联系人本身保留（仍可重新开启聊天）'}</p>
            </div>
            <div class="phone-modal-ft">
                <button class="phone-btn" data-modal-cancel>取消</button>
                <button class="phone-btn phone-btn-warn" id="phone-chat-delete-confirm">删除</button>
            </div>
        </div>
    </div>`;
    getModalContainer().insertAdjacentHTML('beforeend', html);
    const modal = phoneRoot.querySelector('#phone-chat-delete-menu');
    if (!modal) return;
    const close = () => modal.remove();
    modal.querySelectorAll('[data-modal-cancel]').forEach(b => b.addEventListener('click', close));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('#phone-chat-delete-confirm')?.addEventListener('click', () => {
        if (isGroup) {
            State.softDeleteGroup(threadId);
            toastr.success('群聊已删除（30 天可恢复）');
        } else {
            State.deactivateChatThread(chatId, threadId);
            toastr.success('聊天已删除');
        }
        close();
        if (currentThread === threadId) currentThread = null;
        rerender();
    });
}

function openCreateGroupModal() {
    const existing = phoneRoot?.querySelector('#phone-create-group-modal');
    if (existing) existing.remove();
    if (!phoneRoot) return;
    getModalContainer().insertAdjacentHTML('beforeend', renderCreateGroupModal());
    const modal = phoneRoot.querySelector('#phone-create-group-modal');
    if (!modal) return;
    const close = () => modal.remove();
    modal.querySelectorAll('[data-modal-cancel]').forEach(b => b.addEventListener('click', close));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    const nameInput = modal.querySelector('#phone-create-group-name');
    const memberList = modal.querySelector('#phone-create-group-members');
    const confirmBtn = modal.querySelector('#phone-create-group-confirm');
    if (!confirmBtn) return; // 联系人 < 2 时无 confirm 按钮

    const updateConfirm = () => {
        const checked = modal.querySelectorAll('.phone-member-checkbox:checked');
        const name = nameInput?.value.trim() || '';
        confirmBtn.textContent = `创建 (${checked.length})`;
        confirmBtn.disabled = checked.length < 2 || !name;
    };
    nameInput?.addEventListener('input', updateConfirm);
    memberList?.addEventListener('change', updateConfirm);

    confirmBtn?.addEventListener('click', () => {
        const name = nameInput?.value.trim();
        if (!name) { toastr.warning('请输入群名'); return; }
        const checked = [...modal.querySelectorAll('.phone-member-checkbox:checked')];
        if (checked.length < 2) { toastr.warning('至少选 2 个成员'); return; }
        const memberContactIds = checked.map(c => c.dataset.cid);
        try {
            // v0.14.23 群聊建立时捕获当前激活世界书（同 contact sourceBook 逻辑）
            const sourceBook = getActiveBookNames();
            const gid = State.createGroup({ name, memberContactIds, sourceBook });
            toastr.success(`已创建群聊「${name}」`);
            close();
            currentThread = gid;
            rerender();
        } catch (err) {
            toastr.error(err.message || '创建失败');
        }
    });
}

function openGroupPhotoModeModal(groupId) {
    const existing = phoneRoot?.querySelector('#phone-group-photo-modal');
    if (existing) existing.remove();
    if (!phoneRoot) return;
    getModalContainer().insertAdjacentHTML('beforeend', renderGroupPhotoModeModal(groupId));
    const modal = phoneRoot.querySelector('#phone-group-photo-modal');
    if (!modal) return;
    const close = () => modal.remove();
    modal.querySelectorAll('[data-modal-cancel]').forEach(b => b.addEventListener('click', close));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelectorAll('.phone-mode-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            const gid = btn.dataset.groupId;
            close();
            openGroupPhotoMemberPick(gid, mode);
        });
    });
}

function openGroupPhotoMemberPick(groupId, mode) {
    const existing = phoneRoot?.querySelector('#phone-group-photo-pick-modal');
    if (existing) existing.remove();
    if (!phoneRoot) return;
    getModalContainer().insertAdjacentHTML('beforeend', renderGroupPhotoMemberPickModal({ groupId, mode }));
    const modal = phoneRoot.querySelector('#phone-group-photo-pick-modal');
    if (!modal) return;
    const close = () => modal.remove();
    modal.querySelectorAll('[data-modal-cancel]').forEach(b => b.addEventListener('click', close));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    // 引导跳联系人 tab 补外貌
    modal.querySelectorAll('.phone-anchor-go-link').forEach(a => {
        a.addEventListener('click', (e) => {
            e.preventDefault();
            close();
            currentApp = 'messages';
            currentMessagesSubTab = 'contacts';
            currentThread = null;
            rerender();
            toastr.info('请点 ✨ 给该联系人生成外貌锚点，再回群聊重试');
        });
    });

    const confirmBtn = modal.querySelector('#phone-group-photo-confirm');
    const min = parseInt(confirmBtn.dataset.min, 10);
    const max = parseInt(confirmBtn.dataset.max, 10);

    const updateConfirm = () => {
        const checked = modal.querySelectorAll('.phone-photo-member-checkbox:checked');
        confirmBtn.textContent = `生成 (${checked.length}/${max})`;
        confirmBtn.disabled = checked.length < min || checked.length > max;
    };
    modal.addEventListener('change', (e) => {
        if (e.target.classList?.contains('phone-photo-member-checkbox')) {
            const checked = modal.querySelectorAll('.phone-photo-member-checkbox:checked');
            if (checked.length > max) {
                e.target.checked = false;
                toastr.warning(`最多选 ${max} 人`);
            }
            updateConfirm();
        }
    });

    confirmBtn?.addEventListener('click', () => {
        const checked = [...modal.querySelectorAll('.phone-photo-member-checkbox:checked')];
        if (checked.length < min) { toastr.warning(`至少选 ${min} 人`); return; }
        const targetMembers = checked.map(c => c.dataset.name);
        const scene = modal.querySelector('#phone-group-photo-scene')?.value.trim() || '';
        close();
        submitGroupPhotoCommand({ groupId, mode, targetMembers, scene });
    });
}

async function submitGroupPhotoCommand({ groupId, mode, targetMembers, scene }) {
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    const time = Protocol.nowHHMM();
    const group = State.findGroup(groupId);
    if (!group) return;
    const members = State.resolveGroupMembers(group);
    const memberNames = members.map(m => m.nameSnapshot);
    const activeMemberNames = members.filter(m => !m.isDeleted).map(m => m.nameSnapshot);

    const modeDescMap = {
        selfie: '让 ' + targetMembers.join('、') + ' 发自拍',
        group_photo: targetMembers.join('、') + ' 合影',
        paired_group_photo: '分组合照：' + targetMembers.join('、'),
        one_post_others_comment: targetMembers[0] + ' 发图，其他人评价',
        each_own_scene: targetMembers.join('、') + ' 各自发不同场景',
    };
    State.appendGroupMessages(chatId, groupId, [{
        from: ctx.name1 || '我',
        type: 'text',
        content: `[群聊生图指令] ${modeDescMap[mode] || mode}${scene ? `（场景：${scene}）` : ''}`,
        time, me: true,
    }]);
    rerender();

    const ta = document.querySelector('#send_textarea');
    if (!ta) { toastr.error('找不到酒馆输入框'); return; }
    const ooc = Protocol.buildGroupPostCommandOOC({
        groupName: group.name,
        memberNames, activeMemberNames,
        mode, targetMembers, scene, time,
    });
    const safeOoc = Protocol.makeRequestSafe(ooc);
    ta.value = `📱 <Request: ${safeOoc}>`;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#send_but')?.click();
}

// v0.14.10 陌生人 modal handlers
function openStrangerEditModal(name) {
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    const sa = State.getStrangerAnchor(chatId, name);
    if (!sa) return;
    const html = `<div class="phone-modal-bg" id="phone-stranger-edit-modal">
        <div class="phone-modal">
            <div class="phone-modal-hd">修改陌生角色：${escapeHtml(name)}</div>
            <div class="phone-modal-body">
                <div class="phone-form-row">
                    <label class="phone-form-label">类别</label>
                    <select id="phone-stranger-kind" class="phone-input">
                        <option value="fictional_female"${sa.kind === 'fictional_female' ? ' selected' : ''}>🌸 女虚构</option>
                        <option value="fictional_male"${sa.kind === 'fictional_male' ? ' selected' : ''}>⚠ 男虚构</option>
                        <option value="real_origin_female"${sa.kind === 'real_origin_female' ? ' selected' : ''}>⭐ 现实有原型女</option>
                    </select>
                </div>
                <div class="phone-form-row">
                    <label class="phone-form-label">外貌锚点 booru tags</label>
                    <textarea id="phone-stranger-core" class="phone-input" rows="4" style="width:100%;font-family:monospace;font-size:12px;">${escapeHtml(sa.core)}</textarea>
                    <p class="phone-hint" style="font-size:11px;color:#888;margin-top:4px;">每次该角色出现时自动注入这组 tag 保持视觉一致</p>
                </div>
                <div class="phone-form-row">
                    <label class="phone-form-label">出现次数 / 首次时间</label>
                    <p style="margin:4px 0;font-size:12px;color:#666;">${sa.appearCount || 1} 次 · ${new Date(sa.firstSeen || 0).toLocaleString()}</p>
                </div>
            </div>
            <div class="phone-modal-ft">
                <button class="phone-btn" data-modal-cancel>取消</button>
                <button class="phone-btn phone-btn-primary" id="phone-stranger-save">保存</button>
            </div>
        </div>
    </div>`;
    const existing = phoneRoot?.querySelector('#phone-stranger-edit-modal');
    if (existing) existing.remove();
    getModalContainer().insertAdjacentHTML('beforeend', html);
    const modal = phoneRoot.querySelector('#phone-stranger-edit-modal');
    if (!modal) return;
    const close = () => modal.remove();
    modal.querySelectorAll('[data-modal-cancel]').forEach(b => b.addEventListener('click', close));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelector('#phone-stranger-save')?.addEventListener('click', () => {
        const newKind = modal.querySelector('#phone-stranger-kind')?.value || sa.kind;
        const newCore = modal.querySelector('#phone-stranger-core')?.value.trim();
        if (!newCore) { toastr.warning('外貌 tag 不能为空'); return; }
        State.updateStrangerAnchor(chatId, name, { kind: newKind, core: newCore });
        toastr.success('已更新');
        close();
        rerender();
    });
}

function promoteStrangerHandler(name) {
    // v0.14.42 弹完整 preview modal（不再单行 confirm）让用户预览 profile 后决定
    openPromoteStrangerPreviewModal(name);
}

// v0.14.43 换不同 NPC handler — user 点 🎲 后：
// 1. 把 X 加入 rerollExclusion 集（持续到下次 AI 回复后清空）
// 2. 删 strangerAnchor[X]（释放视觉锚）
// 3. pop 最后一批 NPC 消息（包含含 X 的 SMS）
// 4. trigger ST regenerate
// 5. onPromptReady 会读 rerollExclusion 注入 OOC："上次叫 X 的 NPC 不合适，请引入完全不同的"
// 6. AI 重出 → 新 NPC_PROFILE + 新 SUBJECT
async function rerollAsDifferentNpcHandler(name) {
    if (!confirm(`换一个跟「${name}」**完全不同**的 NPC？\n\n会：\n1. 删除当前「${name}」的视觉档案（chat-scoped strangerAnchor）\n2. 撤销上一回合 AI 回复\n3. 让 ST 重新生成，要求 AI 引入跟「${name}」完全不同的新 NPC（姓名/外貌/身份/性格都换）\n\n确认？`)) return;

    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    if (!currentThread) { toastr.warning('请先打开一个聊天'); return; }

    // 1. 加入排除名单（窗口级临时集合）
    if (!window.__smartPhone_rerollExcludeNpcs) window.__smartPhone_rerollExcludeNpcs = new Set();
    window.__smartPhone_rerollExcludeNpcs.add(name);

    // 2. 删 stranger anchor
    State.removeStrangerAnchor(chatId, name);

    // 3. pop 最后一批 NPC 消息（同 handleReroll 流程）
    // v0.14.44 audit fix: 与 handleReroll 对齐 — 群聊路径用 popLastGroupNpcBatch
    // （🆕chip 当前只在 renderBubble 渲染、不在 renderGroupBubble，但保守加分支防 chip 后续也接入群聊渲染）
    const isGroup = isGroupThread(currentThread);
    const removed = isGroup
        ? State.popLastGroupNpcBatch(chatId, currentThread)
        : State.popLastNpcBatch(chatId, currentThread);
    if (!removed.length) {
        toastr.warning('没有可撤销的 AI 回复（可能聊天已被手动清理）');
        window.__smartPhone_rerollExcludeNpcs.delete(name);
        return;
    }
    // v0.14.47 同步清持久化 picUrls
    const removedPics = removed.filter(m => m.pic).map(m => m.pic);
    for (const tag of removedPics) picUrlCache.delete(tag);
    State.deletePicUrlsBatch(chatId, removedPics);
    rerender();

    // 4. trigger ST regenerate
    try {
        const { Generate, is_send_press } = await import('../../../../script.js');
        if (is_send_press) { toastr.warning('正在生成中，请稍候'); return; }
        toastr.info(`已删除「${name}」+ 撤销上一回合，让 AI 重出一个不同的 NPC`);
        Generate('regenerate');
    } catch (err) {
        console.error('[smart-phone v0.14.43] reroll-different-npc failed:', err);
        toastr.error('重新生成失败');
        window.__smartPhone_rerollExcludeNpcs.delete(name); // 失败时撤回
    }
}

// v0.14.42 升级陌生人为联系人时的 preview modal（含完整 profile + 外貌锚预览）
function openPromoteStrangerPreviewModal(name) {
    if (!phoneRoot) return;
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    const sa = State.getStrangerAnchor(chatId, name);
    if (!sa) {
        toastr.error(`找不到陌生角色「${name}」的人设档案`);
        return;
    }
    const existing = document.getElementById('phone-promote-modal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'phone-promote-modal';
    modal.className = 'phone-forward-modal';
    const activeBooks = getActiveBookNames();
    const kindLabel = ({ real_origin_female: '写实女', fictional_female: '二次元/古风女', real_origin_male: '写实男', fictional_male: '二次元/古风男' })[sa.kind] || sa.kind;
    // v0.14.44 用已有的 .phone-forward-card 结构（之前用 .phone-forward-modal-content 等 4 个类名都没 CSS
    // → 内容溢出手机壳，弹窗里的 pre 不滚动而是把整个 modal 撑高，造成 UI bug 截图里的混乱布局）
    const profileHtml = sa.profile
        ? `<pre class="phone-promote-profile-pre">${escapeHtml(sa.profile)}</pre>`
        : '<em>无完整人设档案，仅有外貌 booru</em>';
    modal.innerHTML = `
        <div class="phone-forward-card">
            <div class="phone-forward-header">
                <span>升级 NPC 为正式联系人</span>
                <button class="phone-forward-close" type="button">✕</button>
            </div>
            <div class="phone-forward-body">
                <div><b>姓名：</b>${escapeHtml(name)}</div>
                <div><b>类型：</b>${escapeHtml(kindLabel)}（${escapeHtml(sa.kind || '')}）</div>
                <div><b>世界书归属：</b>${activeBooks.length ? escapeHtml(activeBooks.join(' / ')) : '<em>无激活世界书</em>'}</div>
                <div><b>外貌 booru anchor：</b>
                    <code class="phone-promote-booru-code">${escapeHtml(sa.core || '未提取')}</code>
                </div>
                <div><b>完整人设：</b>${profileHtml}</div>
                <p class="phone-promote-warn">
                    ⚠ 升级后：
                    <br>· 自动加入当前激活的世界书（${activeBooks.length ? escapeHtml(activeBooks.join(',')) : '无'}）
                    <br>· tempOrigin=true → 不会主动出现在朋友圈/小红书/论坛 fresh feed
                    <br>· 仅当你在聊天里主动 cue 时 AI 才会让 ta 出现
                    <br>· 完整人设写入 contact.rawContent，✨ 按钮可重新提取 anchor
                </p>
            </div>
            <div class="phone-forward-footer">
                <button class="phone-forward-cancel" id="phone-promote-cancel" type="button">取消</button>
                <button class="phone-forward-submit" id="phone-promote-confirm" type="button">确认升级</button>
            </div>
        </div>
    `;
    (getModalContainer() || phoneRoot).appendChild(modal);
    modal.querySelector('.phone-forward-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#phone-promote-cancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#phone-promote-confirm').addEventListener('click', () => {
        const ok = State.promoteStrangerToContact(chatId, name, activeBooks);
        if (ok) {
            toastr.success(`「${name}」已升级为联系人，可在联系人 tab 看到`);
            modal.remove();
            rerender();
        } else {
            toastr.error('升级失败');
        }
    });
}

function deleteStrangerHandler(name) {
    if (!confirm(`删除陌生角色「${name}」的外貌锚点？\n\n删除后下次该角色再出现时会重新抽取外貌（可能跟之前不一样）。`)) return;
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    State.removeStrangerAnchor(chatId, name);
    toastr.success('已删除');
    rerender();
}

function openGroupSettingsModal(groupId) {
    const group = State.findGroup(groupId);
    if (!group) return;
    const members = State.resolveGroupMembers(group);
    const memberRows = members.map(m => {
        const tag = m.isDeleted ? '(已删除)' : (m.hasAnchor ? '✅有外貌' : '⚠无外貌');
        const tagClass = m.isDeleted ? 'phone-anchor-deleted' : (m.hasAnchor ? 'phone-anchor-ok' : 'phone-anchor-warn');
        return `<div class="phone-group-settings-row">
            <span>${escapeHtml(m.nameSnapshot)}</span>
            <span class="${tagClass}">${tag}</span>
        </div>`;
    }).join('');
    const html = `<div class="phone-modal-bg" id="phone-group-settings-modal">
        <div class="phone-modal">
            <div class="phone-modal-hd">群设置</div>
            <div class="phone-modal-body">
                <div class="phone-form-row">
                    <label class="phone-form-label">群名</label>
                    <input type="text" id="phone-group-rename-input" class="phone-input" value="${escapeHtml(group.name)}" maxlength="20">
                </div>
                <div class="phone-form-row">
                    <label class="phone-form-label">成员 (${members.filter(m => !m.isDeleted).length} 人)</label>
                    <div class="phone-group-settings-members">${memberRows}</div>
                </div>
            </div>
            <div class="phone-modal-ft">
                <button class="phone-btn" data-modal-cancel>取消</button>
                <button class="phone-btn phone-btn-warn" id="phone-group-delete-btn">删除</button>
                <button class="phone-btn phone-btn-primary" id="phone-group-rename-confirm">保存</button>
            </div>
        </div>
    </div>`;
    const existing = phoneRoot?.querySelector('#phone-group-settings-modal');
    if (existing) existing.remove();
    getModalContainer().insertAdjacentHTML('beforeend', html);
    const modal = phoneRoot.querySelector('#phone-group-settings-modal');
    const close = () => modal.remove();
    modal.querySelectorAll('[data-modal-cancel]').forEach(b => b.addEventListener('click', close));
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    modal.querySelector('#phone-group-rename-confirm')?.addEventListener('click', () => {
        const newName = modal.querySelector('#phone-group-rename-input')?.value.trim();
        if (!newName) { toastr.warning('群名不能为空'); return; }
        State.updateGroup(groupId, { name: newName });
        toastr.success('已保存');
        close();
        rerender();
    });
    modal.querySelector('#phone-group-delete-btn')?.addEventListener('click', () => {
        if (!confirm(`确定删除群聊「${group.name}」？聊天记录保留 30 天可恢复。`)) return;
        State.softDeleteGroup(groupId);
        toastr.success('群聊已删除');
        close();
        currentThread = null;
        rerender();
    });
}
