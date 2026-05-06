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
import { testPhoneApi, fetchProviderModels, callPhoneApi } from './lib/phone-api.js';
import { generateStrangerComments, generateFreshFeed } from './lib/xhs-api.js';
import { renderMessageList, renderThread, renderMessagesSubTabs, renderContactsTab } from './lib/apps/messages.js';
import { renderForum } from './lib/apps/forum.js';
import { renderXHS, bindXHSHandlers, getActiveView as xhsView, setView as xhsSetView } from './lib/apps/xhs.js';
import { renderSettings, bindSettingsHandlers, entryToContact } from './lib/apps/settings.js';
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
                <div class="smart-phone-tabbar">
                    <button class="smart-phone-tab" data-app="messages">💬<small>消息</small></button>
                    <button class="smart-phone-tab" data-app="forum">📋<small>论坛</small></button>
                    <button class="smart-phone-tab" data-app="xhs">📕<small>小红书</small></button>
                    <button class="smart-phone-tab" data-app="settings">⚙️<small>设置</small></button>
                </div>
                <button class="smart-phone-close" title="收起">×</button>
            </div>
        </div>
    `);
    phoneRoot = document.getElementById('smart-phone-shell');

    $('.smart-phone-tab').on('click', (e) => {
        currentApp = e.currentTarget.dataset.app;
        currentThread = null;
        currentMessagesSubTab = 'chats';
        xhsSetView('feed');
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
        return ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)
            || !!el.closest('#smart-phone-screen');
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

    const NO_CHAT_HTML = '<div class="phone-empty" style="padding:48px 20px">请先在酒馆进入一个对话</div>';

    let html = '';
    switch (currentApp) {
        case 'messages':
            if (!ctx.chatId) {
                html = NO_CHAT_HTML;
            } else if (currentThread) {
                html = renderThread(chatId, currentThread);
            } else {
                const subTabHdr = renderMessagesSubTabs(currentMessagesSubTab);
                html = subTabHdr + (currentMessagesSubTab === 'contacts'
                    ? renderContactsTab()
                    : renderMessageList(chatId));
            }
            break;
        case 'forum':
            html = ctx.chatId ? renderForum(chatId) : NO_CHAT_HTML;
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
                    row.addEventListener('click', () => { currentThread = row.dataset.thread; rerender(); });
                });
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
            }
        } else {
            screen.querySelector('[data-back]')?.addEventListener('click', () => { currentThread = null; rerender(); });
            screen.querySelector('#phone-reroll-btn')?.addEventListener('click', handleReroll);
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
        }
    }
    if (currentApp === 'xhs') {
        bindXHSHandlers(screen, {
            onCompose: () => { xhsSetView('compose'); rerender(); },
            onRefresh: handleXhsRefresh,
            onOpenPost: (id) => { xhsSetView('detail', id); rerender(); },
            onBackToFeed: () => { xhsSetView('feed'); rerender(); },
            onSubmit: handleXhsSubmit,
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
            onRefresh: () => { toastr.info('刷新中…'); rerender(); },
            onApiSave: handleApiSave,
            onApiTest: handleApiTest,
            onApiTriggerNow: () => toastr.info('该功能保留给手动调用，目前消息生成走主聊天 AI'),
            onComfyuiTest: handleComfyuiTest,
            onFetchModels: handleFetchModels,
            onPromptEdit: handlePromptEdit,
            onGenAppearance: handleGenerateAppearance,
        });
    }

    triggerPicSlots(screen);
}

// ─────────────────────────────────────────────────────────────────────────
// Event wiring
// ─────────────────────────────────────────────────────────────────────────

function bindEvents() {
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.MESSAGE_UPDATED, onMessageReceived); // re-parse on edits
    eventSource.on(event_types.CHAT_CHANGED, () => { currentThread = null; xhsSetView('feed'); rerender(); });
}

function onPromptReady(eventData) {
    const s = State.load();
    if (!s.enabled) return;
    const contacts = s.contacts.map((c) => ({ name: c.name, note: c.note }));
    const lore = (s.worldbook?.importedEntries || []).filter((e) => e.type === 'lore' && e.enabled);
    const styleRule = Protocol.buildProtocolPrompt({ contacts, lore });
    eventData.chat.push({ role: 'system', content: styleRule });
}

async function onMessageReceived() {
    const s = State.load();
    if (!s.enabled) return;
    const ctx = getContext();
    const idx = ctx.chat.length - 1;
    const msg = ctx.chat[idx];
    if (!msg || msg.is_user) return;

    const parsed = Protocol.parsePhoneFromMessage(msg.mes);
    if (!parsed) return;

    const chatId = ctx.chatId || 'default';
    if (parsed.sms?.length) State.appendMessages(chatId, parsed.sms);
    if (parsed.moments?.length) State.appendMoments(chatId, parsed.moments);
    // group / hongbao / voice currently routed into threads as well
    if (parsed.hongbao?.length) State.appendMessages(chatId, parsed.hongbao);
    if (parsed.voice?.length) State.appendMessages(chatId, parsed.voice);
    if (parsed.group?.length) {
        // group msgs also go into a per-group thread keyed by group name
        const grouped = parsed.group.map((g) => ({
            from: g.group || g.from,
            type: 'text',
            content: `${g.from}: ${g.content}`,
            time: g.time,
            me: false,
            pic: g.pic,
        }));
        State.appendMessages(chatId, grouped);
    }

    // Strip the <PHONE> block from displayed message
    const stripped = Protocol.stripPhoneBlock(msg.mes);
    if (stripped !== msg.mes) {
        const cleaned = stripped.replace(/<\/?[^>]+>/g, '').replace(/\s+/g, '').trim();
        // Abstract-style: if the whole reply was phone-only, show a tiny placeholder
        // so the chat doesn't show an empty bubble.
        msg.mes = cleaned ? stripped : '📱';
        try {
            const updateBlock = (await import('../../../../script.js')).updateMessageBlock;
            if (typeof updateBlock === 'function') updateBlock(idx, msg);
        } catch {}
    }

    rerender();
}

// ─────────────────────────────────────────────────────────────────────────
// SMS send: user → main chat textarea (mochi style)
// ─────────────────────────────────────────────────────────────────────────

async function handleSendSMS(text) {
    if (!text || !currentThread) return;
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    const time = Protocol.nowHHMM();

    // 1. Push user's bubble into phone state immediately
    State.appendMessages(chatId, [{
        from: currentThread,
        type: 'text',
        content: text,
        time,
        me: true,
    }]);

    // 2. Clear input + re-render
    const input = phoneRoot?.querySelector('#phone-input');
    if (input) input.value = '';
    rerender();

    // 3. Build OOC + post into ST's main textarea.
    // Visible bubble is tiny (📱) so chat stays clean. Real content goes to AI via
    // the embedded SMS in the OOC instruction.
    const ta = document.querySelector('#send_textarea');
    if (!ta) {
        toastr.error('找不到酒馆输入框，无法发送');
        return;
    }
    const ooc = Protocol.buildSendOOC({ targetName: currentThread, time, userText: text, isGroup: false });
    const safeOoc = Protocol.makeRequestSafe(ooc);
    const wrapped = `📱 <Request: ${safeOoc}>`;

    ta.value = wrapped;
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
    const removed = State.popLastNpcBatch(chatId, currentThread);
    if (!removed.length) { toastr.warning('没有可重新生成的消息'); return; }
    for (const m of removed) {
        if (m.pic) picUrlCache.delete(m.pic);
    }
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
// XHS (小红书)
// ─────────────────────────────────────────────────────────────────────────

async function handleXhsSubmit({ title, body, tag }) {
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
        title: title || body.slice(0, 20) + (body.length > 20 ? '...' : ''),
        body,
        tag,
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

async function handleXhsRefresh() {
    const ctx = getContext();
    const chatId = ctx.chatId || 'default';
    toastr.info('生成新帖子…');
    const worldCtxEntries = State.getWorldContext();
    const worldContextText = worldCtxEntries.length
        ? await WB.fetchWorldContextText(worldCtxEntries)
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
    const contact = entryToContact(e);
    State.upsertContact(contact);
    toastr.success(`已导入：${contact.name}`);
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

async function handleGenerateAppearance(name, btn) {
    const c = State.findContact(name);
    if (!c?.rawContent) return toastr.warning('联系人没有世界书内容，无法生成外貌 tags');

    const s = State.load();
    const cfg = s.api || {};
    if (!cfg.url || !cfg.key) {
        return toastr.warning('请先在「设置 → 手机 API」填写 URL 和 Key');
    }

    const origText = btn?.textContent || '✨';
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

    try {
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
                        content: `你是顶级 Stable Diffusion / Danbooru tag 工程师。把中文角色设定转成最大化还原人设的英文 booru tag。

严格输出格式（只输出两行，不加任何其他文字）：
APPEARANCE: [一行 booru tag，英文逗号分隔，必须 ≥100 个 tag]
FULL: [APPEARANCE 前后加上质量词和构图词的完整 SD 正面 prompt，一行]

只用标准 Danbooru / NovelAI tag。严禁中式描述如 "jade-like skin"、"gentle gaze"、"phoenix crown"（要拆成 hair ornament, ornate, jeweled hair ornament）。原文没说的维度必须按世界观和气质推断填充，绝不留空。

**必填维度**：
- 眼睛颜色（必填，原文没写就按发色/世界观推断）
- 肤色色调（fair/pale/light/tan/dark skin 选准 + 用 porcelain skin/light skin/healthy skin/sun-kissed skin 等强化）
- 服装（根据角色世界观/身份/出场场景推断穿什么 — 古风/修仙写 hanfu, chinese clothes, silk robes 等；现代写 casual clothes/dress/uniform 等；列出至少 8 个服装相关 tag 涵盖款式+材质+花纹+配饰）

同一特征多写近义词强化（SD 对重复 tag 会增强权重）。关键特征用 (tag:1.3) 加权重，每段最多 2-3 个加权。禁止：武器、职业技能、故事背景、性格心理描述、性行为描写。`,
                    },
                    {
                        role: 'user',
                        content: `示例 1 — 古风修仙女主（紫发凤眼大胸贵妃气质，肤色白皙，穿汉服丝绸）：

APPEARANCE: dark purple hair, deep purple hair, violet hair, gradient hair, very long hair, waist-length hair, flowing hair, silky hair, shiny hair, updo, high bun, hair bun, elegant updo, chinese hairstyle, golden hairpin, hair stick, hair ornament, ornate hair ornament, jeweled hair ornament, tassel hair ornament, gold accessories, hair flower, (purple eyes:1.3), violet eyes, amethyst eyes, bright eyes, sharp eyes, almond eyes, narrow eyes, tsurime, fox eyes, long eyelashes, double eyelid, eyeshadow, eyeliner, sparkling eyes, detailed eyes, beautiful eyes, fair skin, pale skin, white skin, porcelain skin, light skin, smooth skin, flawless skin, glowing skin, luminous skin, high cheekbones, delicate features, sharp jawline, oval face, beautiful face, perfect face, symmetrical face, thin lips, small mouth, delicate nose, light makeup, lipstick, blush, tall, tall female, long legs, slender, curvy, voluptuous, hourglass figure, mature body, perfect body, visible collarbones, (huge breasts:1.3), gigantic breasts, massive breasts, enormous breasts, heavy breasts, large breasts, big breasts, very large breasts, voluptuous breasts, busty, round breasts, narrow waist, slim waist, thin waist, slender waist, wide hips, flared hips, curvy hips, thick thighs, plump thighs, beautiful legs, hanfu, chinese clothes, traditional chinese clothes, silk robes, embroidered robes, layered robes, long dress, flowing dress, wide sleeves, long sleeves, ornate clothing, embroidered pattern, gold embroidery, sash, jade pendant, jade necklace, brocade, mature female, adult, adult female, mature, elegant, regal, dignified, graceful, majestic, noble, aristocratic, refined, sophisticated, cold, mysterious, east asian, asian, oriental beauty
FULL: masterpiece, best quality, ultra-detailed, highres, 8k uhd, absurdres, intricate details, 1girl, solo, upper body portrait, looking at viewer, simple background, white background, studio lighting, professional photography, dark purple hair, deep purple hair, violet hair, gradient hair, very long hair, waist-length hair, flowing hair, silky hair, shiny hair, updo, high bun, hair bun, elegant updo, chinese hairstyle, golden hairpin, hair stick, hair ornament, ornate hair ornament, jeweled hair ornament, tassel hair ornament, gold accessories, hair flower, (purple eyes:1.3), violet eyes, amethyst eyes, bright eyes, sharp eyes, almond eyes, narrow eyes, tsurime, fox eyes, long eyelashes, double eyelid, eyeshadow, eyeliner, sparkling eyes, detailed eyes, beautiful eyes, fair skin, pale skin, white skin, porcelain skin, light skin, smooth skin, flawless skin, glowing skin, luminous skin, high cheekbones, delicate features, sharp jawline, oval face, beautiful face, perfect face, symmetrical face, thin lips, small mouth, delicate nose, light makeup, lipstick, blush, tall, tall female, long legs, slender, curvy, voluptuous, hourglass figure, mature body, perfect body, visible collarbones, (huge breasts:1.3), gigantic breasts, massive breasts, enormous breasts, heavy breasts, large breasts, big breasts, very large breasts, voluptuous breasts, busty, round breasts, narrow waist, slim waist, thin waist, slender waist, wide hips, flared hips, curvy hips, thick thighs, plump thighs, beautiful legs, hanfu, chinese clothes, traditional chinese clothes, silk robes, embroidered robes, layered robes, long dress, flowing dress, wide sleeves, long sleeves, ornate clothing, embroidered pattern, gold embroidery, sash, jade pendant, jade necklace, brocade, mature female, adult, adult female, mature, elegant, regal, dignified, graceful, majestic, noble, aristocratic, refined, sophisticated, cold, mysterious, east asian, asian, oriental beauty, soft lighting, cinematic lighting, rim light, detailed skin, sharp focus, depth of field, photorealistic, hyperrealistic, ultra realistic

示例 2 — 现代年轻女学生（浅紫长发凤眼活泼巨乳，肤色白嫩，穿校服）：

APPEARANCE: light purple hair, lavender hair, pastel purple hair, lilac hair, long hair, very long hair, wavy hair, loose hair, flowing hair, silky hair, glossy hair, side-swept hair, golden hair ribbon, jade hairpin, hair ornament, hair accessories, (purple eyes:1.2), light purple eyes, lavender eyes, bright eyes, sparkling eyes, lively eyes, phoenix eyes, almond eyes, upturned eyes, large eyes, long eyelashes, double eyelid, sparkly eyes, detailed eyes, beautiful eyes, fair skin, pale skin, light skin, white skin, smooth skin, flawless skin, glowing skin, soft skin, healthy skin, delicate features, pretty face, beautiful face, oval face, small nose, delicate nose, thin lips, small mouth, parted lips, light makeup, lip gloss, blush, young adult, teenage, youthful, young, slender, curvy, hourglass figure, perfect body, visible collarbones, slim, (huge breasts:1.3), gigantic breasts, massive breasts, heavy breasts, large breasts, big breasts, very large breasts, voluptuous breasts, busty, round breasts, perky breasts, i-cup, narrow waist, slim waist, thin waist, wide hips, flared hips, curvy hips, thick thighs, plump thighs, long legs, beautiful legs, smooth legs, school uniform, japanese school uniform, sailor uniform, white shirt, pleated skirt, plaid skirt, black skirt, neckerchief, ribbon tie, knee-high socks, white socks, school shoes, blazer, cardigan, casual clothes, young woman, teen, lively, cheerful, energetic, charming, attractive, cute, beautiful, pretty, east asian, asian
FULL: masterpiece, best quality, ultra-detailed, highres, 8k uhd, absurdres, intricate details, 1girl, solo, upper body portrait, looking at viewer, simple background, white background, studio lighting, professional photography, light purple hair, lavender hair, pastel purple hair, lilac hair, long hair, very long hair, wavy hair, loose hair, flowing hair, silky hair, glossy hair, side-swept hair, golden hair ribbon, jade hairpin, hair ornament, hair accessories, (purple eyes:1.2), light purple eyes, lavender eyes, bright eyes, sparkling eyes, lively eyes, phoenix eyes, almond eyes, upturned eyes, large eyes, long eyelashes, double eyelid, sparkly eyes, detailed eyes, beautiful eyes, fair skin, pale skin, light skin, white skin, smooth skin, flawless skin, glowing skin, soft skin, healthy skin, delicate features, pretty face, beautiful face, oval face, small nose, delicate nose, thin lips, small mouth, parted lips, light makeup, lip gloss, blush, young adult, teenage, youthful, young, slender, curvy, hourglass figure, perfect body, visible collarbones, slim, (huge breasts:1.3), gigantic breasts, massive breasts, heavy breasts, large breasts, big breasts, very large breasts, voluptuous breasts, busty, round breasts, perky breasts, i-cup, narrow waist, slim waist, thin waist, wide hips, flared hips, curvy hips, thick thighs, plump thighs, long legs, beautiful legs, smooth legs, school uniform, japanese school uniform, sailor uniform, white shirt, pleated skirt, plaid skirt, black skirt, neckerchief, ribbon tie, knee-high socks, white socks, school shoes, blazer, cardigan, casual clothes, young woman, teen, lively, cheerful, energetic, charming, attractive, cute, beautiful, pretty, east asian, asian, soft lighting, cinematic lighting, rim light, detailed skin, sharp focus, depth of field, photorealistic, hyperrealistic, ultra realistic

—— 现在轮到你 ——
角色设定（中文）：

${c.rawContent}

请按上面示例的格式和详细程度输出 APPEARANCE（≥100 tag）和 FULL 两段。
- 眼睛颜色必填（原文没写就按发色/世界观推断）
- 肤色细分必填（fair/pale/light/tan/dark 选准 + 强化词如 porcelain/healthy/sun-kissed/glowing 等）
- 服装必填，根据世界观/身份/出场场景推断（古风→hanfu/silk robes；现代学生→school uniform；现代职场→business suit；修仙→cultivator robes/taoist robes 等），列出至少 8-12 个服装相关 tag 涵盖款式+材质+花纹+配饰。`,
                    },
                ],
                temperature: 1,
                max_tokens: 3000,
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
    toastr.info('测试 ComfyUI 连接…');
    try {
        const resp = await fetch(`${url.replace(/\/+$/, '')}/system_stats`);
        if (!resp.ok) {
            toastr.error(`❌ ComfyUI 响应 ${resp.status}`);
            return;
        }
        const data = await resp.json();
        const ver = data?.system?.comfyui_version || data?.system?.python_version || 'unknown';
        toastr.success(`✅ ComfyUI 已连接 (${ver})`);
    } catch (err) {
        toastr.error(`❌ 无法连接：${err.message || err}（确认 ComfyUI 启动时加 --enable-cors-header '*'）`);
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Image slot dispatch
// ─────────────────────────────────────────────────────────────────────────

function openImageLightbox(src) {
    if (document.getElementById('sp-lightbox')) return;
    const overlay = document.createElement('div');
    overlay.id = 'sp-lightbox';
    overlay.setAttribute('style', [
        'position: fixed !important',
        'top: 0 !important', 'left: 0 !important',
        'width: 100% !important', 'height: 100% !important',
        'background: rgba(0,0,0,0.92) !important',
        'z-index: 2147483645 !important',
        'display: flex !important',
        'align-items: center !important',
        'justify-content: center !important',
        'cursor: zoom-out !important',
        'touch-action: pinch-zoom !important',
    ].join('; '));
    const img = document.createElement('img');
    img.src = src;
    img.setAttribute('style', 'max-width:100%;max-height:100%;object-fit:contain;touch-action:pinch-zoom');
    overlay.appendChild(img);
    overlay.addEventListener('click', () => overlay.remove());
    (document.documentElement || document.body).appendChild(overlay);
}

function attachPicClick(slot, url) {
    const img = slot.querySelector('img');
    if (img) img.addEventListener('click', () => openImageLightbox(url));
}

function triggerPicSlots(screen) {
    const slots = screen.querySelectorAll('.phone-image-slot[data-pic]:not([data-loaded])');
    if (!slots.length) return;
    if (!window.smartImageGen?.generateFromPicTag) return;

    slots.forEach(async (slot) => {
        slot.setAttribute('data-loaded', '1');
        const picTag = slot.dataset.pic;

        // Serve cached URL immediately — no regeneration on tab switch or re-render
        if (picUrlCache.has(picTag)) {
            const url = picUrlCache.get(picTag);
            slot.innerHTML = `<img src="${escapeHtml(url)}" class="phone-pic">`;
            attachPicClick(slot, url);
            return;
        }

        try {
            const url = await window.smartImageGen.generateFromPicTag(picTag, {
                contacts: State.load().contacts,
                // Pass current thread name so locked character seeds are applied
                hint: currentThread ? { from: currentThread } : {},
            });
            if (url) {
                slot.innerHTML = `<img src="${escapeHtml(url)}" class="phone-pic">`;
                attachPicClick(slot, url);
                picUrlCache.set(picTag, url);
            } else slot.textContent = '📷 生成失败';
        } catch (err) {
            console.error(err);
            slot.textContent = `📷 ${err.message || err}`;
        }
    });
}

// Public API for image-gen extension
window.smartPhone = {
    getContacts: () => State.load().contacts,
    findContact: (name) => State.findContact(name),
    getCurrentModel: () => State.load().imageGen.currentModel,
    getComfyuiUrl: () => getActiveComfyuiUrl(),
    getWorkflowPath: (model) => State.load().imageGen.workflowPaths[model],
};
