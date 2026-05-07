// Settings app — worldbook import, contacts, model selection
import { load, save, upsertContact, removeContact, getWorldContext } from '../state.js';
import { listClassifiedEntries, entryToContact, guessName, getActiveBookNames } from '../worldbook.js';
import { API_PRESETS, MODEL_SUGGESTIONS } from '../phone-api.js';
import { escapeHtml } from '../util.js';

// Module-level toggle for "show all contacts (including inactive worldbooks)"
let showAllContactsFlag = false;
export function getShowAllContactsFlag() { return showAllContactsFlag; }
export function setShowAllContactsFlag(v) { showAllContactsFlag = !!v; }

// Filter helper used by contacts section. Active books = ST-active + cross-world sharing.
// A contact is visible if:
//   - showAllContactsFlag = true (escape hatch), OR
//   - sourceBook empty/unset → orphan (default hidden), OR
//   - any of contact.sourceBook in activeBookNames
// Returns { visible, orphans, all }
export function partitionContacts(contacts, activeBookNames) {
    const activeSet = new Set(activeBookNames || []);
    const visible = [];
    const orphans = [];
    for (const c of (contacts || [])) {
        const sb = Array.isArray(c.sourceBook) ? c.sourceBook : (c.sourceBook ? [c.sourceBook] : []);
        if (sb.length === 0) {
            orphans.push(c);
            continue;
        }
        if (sb.some((b) => activeSet.has(b))) {
            visible.push(c);
        }
    }
    return { visible, orphans, all: contacts || [] };
}

// Persists collapse state across tab switches within the same page session.
// 世界书条目 defaults to collapsed (can be long).
const collapsedSections = new Set(['worldbook']);

function sectionToggle(id) {
    const arrow = collapsedSections.has(id) ? '▶' : '▼';
    return `<button class="phone-section-toggle" data-section="${id}">${arrow}</button>`;
}

function sectionBodyOpen(id) {
    return `<div class="phone-section-body${collapsedSections.has(id) ? ' phone-collapsed' : ''}" data-section="${id}">`;
}

export async function renderSettings() {
    const s = load();
    const worldCtx = getWorldContext();
    const entries = await listClassifiedEntries();
    // Sets for fast "already imported" / "already in world context" lookup
    const importedNames = new Set((s.contacts || []).map((c) => c.name));
    const wcKey = (e) => `${e.uid}|${e.bookName}`;
    const wcSet = new Set((worldCtx || []).map((w) => `${w.uid}|${w.bookName}`));
    // World-book scoped contact filtering
    const activeBookNames = getActiveBookNames();
    const { visible: visibleContacts, orphans: orphanContacts } = partitionContacts(s.contacts, activeBookNames);
    const contactsToRender = showAllContactsFlag ? (s.contacts || []) : visibleContacts;

    return `
        <div class="phone-settings">

            <section class="phone-settings-section">
                <div class="phone-settings-header">
                    <h3>📡 手机 API（独立于主聊天）</h3>
                    ${sectionToggle('api')}
                </div>
                ${sectionBodyOpen('api')}
                <p class="phone-settings-hint">用单独的 OpenAI 兼容 API 生成手机消息/朋友圈/微博/论坛。建议接入 DeepSeek 等更快更便宜的模型。空着则回退到酒馆主 API。</p>
                <div class="phone-api-presets">
                    ${API_PRESETS.map((p) => `<button class="phone-btn phone-api-preset" data-url="${escapeHtml(p.url)}" data-model="${escapeHtml(p.model)}">${escapeHtml(p.name)}</button>`).join('')}
                </div>
                <label class="phone-settings-row">
                    API 地址
                    <input id="phone-api-url" type="url" class="phone-input" value="${escapeHtml(s.api?.url || '')}" placeholder="https://api.deepseek.com/v1">
                </label>
                <label class="phone-settings-row">
                    API Key
                    <input id="phone-api-key" type="password" class="phone-input" value="${escapeHtml(s.api?.key || '')}" placeholder="sk-...">
                </label>
                <label class="phone-settings-row">
                    模型名称
                    <select id="phone-api-model" class="phone-select">
                        ${MODEL_SUGGESTIONS.map((m) => `<option value="${escapeHtml(m)}"${(s.api?.model || '') === m ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('')}
                        <option value="__custom__"${!MODEL_SUGGESTIONS.includes(s.api?.model || '') && (s.api?.model || '') ? ' selected' : ''}>自定义…</option>
                    </select>
                    <input id="phone-api-model-custom" type="text" class="phone-input"
                        style="margin-top:6px;display:${!MODEL_SUGGESTIONS.includes(s.api?.model || '') && (s.api?.model || '') ? 'block' : 'none'}"
                        value="${escapeHtml(!MODEL_SUGGESTIONS.includes(s.api?.model || '') ? (s.api?.model || '') : '')}"
                        placeholder="输入自定义模型名称">
                    <button type="button" id="phone-api-fetch-models" class="phone-btn phone-link-btn">📥 从服务器拉取模型列表</button>
                </label>
                <label class="phone-settings-row">
                    触发方式
                    <select id="phone-api-trigger" class="phone-select">
                        <option value="auto" ${s.api?.triggerMode === 'auto' ? 'selected' : ''}>自动 (主 AI 回复后)</option>
                        <option value="manual" ${s.api?.triggerMode === 'manual' ? 'selected' : ''}>手动 (按按钮)</option>
                    </select>
                </label>
                <label class="phone-settings-row" style="flex-direction:row;align-items:center;gap:8px">
                    <input id="phone-api-use-main" type="checkbox" ${s.api?.useMainPreset ? 'checked' : ''}>
                    <span>走 SillyTavern 主聊天预设（NSFW 帖子/评论可用）</span>
                </label>
                <p class="phone-settings-hint" style="margin:-4px 0 8px 0;font-size:0.85em;line-height:1.4">
                    ✅ 推荐当主聊天用了带越狱的预设（如 夏瑾/双鱼座 等）：所有手机文字生成（朋友圈/小红书/论坛/陌生人评论）会经过预设管线，越狱自动生效，NSFW 内容能写出来。<br>
                    ❌ 关闭则走上方的独立 API（DeepSeek 等），便宜快但 NSFW 多半会被拒绝。
                </p>
                <div class="phone-settings-actions">
                    <button id="phone-api-test" class="phone-btn">🔌 测试连接</button>
                    <button id="phone-api-trigger-now" class="phone-btn">⚡ 立即生成一次</button>
                </div>
                </div>
            </section>

            <section class="phone-settings-section">
                <div class="phone-settings-header">
                    <h3>生图模型</h3>
                    ${sectionToggle('imageGen')}
                </div>
                ${sectionBodyOpen('imageGen')}
                <select id="phone-model-select" class="phone-select">
                    <option value="pony" ${s.imageGen.currentModel === 'pony' ? 'selected' : ''}>Pony Realism (欧美写实/默认)</option>
                    <option value="majicmix" ${s.imageGen.currentModel === 'majicmix' ? 'selected' : ''}>majicMIX v7 (亚洲写真·SD1.5)</option>
                    <option value="asian_realism" ${s.imageGen.currentModel === 'asian_realism' ? 'selected' : ''}>Asian Realism by Stable (亚洲写实·PONY-XL·3 LoRA)</option>
                    <option value="noobai" ${s.imageGen.currentModel === 'noobai' ? 'selected' : ''}>NoobAI vPred (动漫)</option>
                    <option value="noobai_easyneg" ${s.imageGen.currentModel === 'noobai_easyneg' ? 'selected' : ''}>NoobAI vPred + EasyNegative (动漫·画质增强)</option>
                    <option value="noobai_miaomiao" ${s.imageGen.currentModel === 'noobai_miaomiao' ? 'selected' : ''}>NoobAI vPred + EasyNeg + miaomiaoHarem (动漫·画风增强)</option>
                </select>
                <label class="phone-settings-row">
                    💻 ComfyUI 地址（电脑）
                    <input id="phone-comfyui-url" type="text" class="phone-input" value="${escapeHtml(s.imageGen.comfyuiUrl)}" placeholder="http://127.0.0.1:8188">
                </label>
                <label class="phone-settings-row">
                    📱 ComfyUI 地址（手机，局域网 IP）
                    <input id="phone-comfyui-url-mobile" type="text" class="phone-input"
                        value="${escapeHtml(s.imageGen.comfyuiUrlMobile || '')}"
                        placeholder="http://192.168.1.x:8188（空=与电脑端相同）">
                    <span class="phone-settings-hint" style="margin-top:4px">手机访问时自动用此地址；ComfyUI 需加 <b>--enable-cors-header * --listen 0.0.0.0</b></span>
                </label>
                <button type="button" id="phone-comfyui-test" class="phone-btn phone-link-btn">🔌 测试当前设备连接</button>
                </div>
            </section>

            <section class="phone-settings-section">
                <div class="phone-settings-header">
                    <h3>世界书条目（${entries.length}）</h3>
                    <button id="phone-wb-refresh" class="phone-btn" title="重新扫描激活的世界书">🔄</button>
                    ${sectionToggle('worldbook')}
                </div>
                ${sectionBodyOpen('worldbook')}
                <p class="phone-settings-hint">读取自当前激活的世界书（全局 + 角色绑定 + 聊天绑定）。每条都可以**手动**选作"联系人"或"世界观"——两个标记可同时存在。</p>
                <div class="phone-wb-list">
                    ${entries.length === 0
                        ? '<div class="phone-empty-inline">无条目（点 🔄 重新扫描激活的世界书）</div>'
                        : entries.map((e) => {
                            const guessedName = guessName(e);
                            const isContact = importedNames.has(guessedName);
                            const isWc = wcSet.has(wcKey(e));
                            return `
                                <div class="phone-wb-row" data-uid="${e.uid}" data-book="${escapeHtml(e.bookName)}">
                                    <div class="phone-wb-text">
                                        <div class="phone-wb-comment">${escapeHtml(e.comment || '(无注释)')}</div>
                                        <div class="phone-wb-meta">📖 ${escapeHtml(e.bookName)}</div>
                                        <div class="phone-wb-preview">${escapeHtml(e.content)}…</div>
                                    </div>
                                    <div class="phone-wb-actions">
                                        <button class="phone-btn phone-import-contact ${isContact ? 'phone-wb-active' : ''}"
                                            data-uid="${e.uid}" data-book="${escapeHtml(e.bookName)}"
                                            title="${isContact ? '已导入为联系人（再点更新）' : '导入为联系人（用于手机短信、生图角色锚点）'}">
                                            ${isContact ? '✅ 联系人' : '👤 联系人'}
                                        </button>
                                        <button class="phone-btn phone-toggle-wc ${isWc ? 'phone-wb-active' : ''}"
                                            data-uid="${e.uid}" data-book="${escapeHtml(e.bookName)}" data-name="${escapeHtml(e.comment || '')}"
                                            title="${isWc ? '已加入世界观（再点移除）' : '加入世界观（注入到 XHS / 论坛 / 朋友圈 AI 生成）'}">
                                            ${isWc ? '✅ 世界观' : '📖 世界观'}
                                        </button>
                                    </div>
                                </div>`;
                        }).join('')
                    }
                </div>
                </div>
            </section>

            <section class="phone-settings-section">
                <div class="phone-settings-header">
                    <h3>联系人（${showAllContactsFlag ? s.contacts.length : visibleContacts.length}${showAllContactsFlag ? ' / 全部' : ''}）</h3>
                    ${sectionToggle('contacts')}
                </div>
                ${sectionBodyOpen('contacts')}
                <p class="phone-settings-hint">联系人按当前激活的世界书过滤。切换卡片自动换列表，anchor 永久保留。</p>

                ${orphanContacts.length > 0 ? `
                <div class="phone-orphan-banner">
                    <div class="phone-orphan-text">⚠️ ${orphanContacts.length} 个联系人未归属世界书</div>
                    <div class="phone-orphan-actions">
                        <button id="phone-batch-assign-btn" class="phone-btn">🛠 批量分配</button>
                        <button id="phone-orphans-delete-btn" class="phone-btn phone-btn-danger">🗑 全部删除</button>
                    </div>
                </div>
                ` : ''}

                <div class="phone-contacts-actions">
                    <button id="phone-import-from-other-world-btn" class="phone-btn" ${activeBookNames.length === 0 ? 'disabled' : ''} title="${activeBookNames.length === 0 ? '当前没有激活的世界书' : '把其他世界的联系人引入到当前世界'}">
                        📥 从其他世界引入
                    </button>
                </div>

                <div class="phone-contact-list">
                    ${contactsToRender.length
                        ? contactsToRender.map(renderContactRow).join('')
                        : `<div class="phone-empty-inline">${activeBookNames.length === 0 ? '当前没有激活的世界书。' : '当前世界还没联系人。'}<br><small>从设置上方"世界书条目"导入${activeBookNames.length > 0 ? '，或点 📥 从其他世界引入' : ''}</small></div>`
                    }
                </div>

                <div class="phone-contacts-bottom">
                    <label class="phone-show-all-label">
                        <input type="checkbox" id="phone-show-all-contacts" ${showAllContactsFlag ? 'checked' : ''}>
                        🔍 显示所有联系人（含未激活世界 / 未归属）
                    </label>
                </div>
                </div>
            </section>

        </div>
    `;
}

// renderWbRow removed v0.10.3 — unified UI now renders entries inline with two buttons each
// (👤 联系人 / 📖 世界观). Auto-classification kept in worldbook.js for backwards compat but no
// longer drives the UI; user explicitly picks per-entry.

function renderContactRow(c) {
    const locked = c.anchor?.locked;
    const hasImg = !!c.anchor?.referenceImage;
    const hasContent = !!c.rawContent;
    const refImg = hasImg
        ? `<img class="phone-contact-ref" src="${escapeHtml(c.anchor.referenceImage)}" title="点击查看大图" style="cursor:zoom-in">`
        : `<div class="phone-contact-ref placeholder">无参考图</div>`;
    return `
        <div class="phone-contact-row" data-name="${escapeHtml(c.name)}">
            ${refImg}
            <div class="phone-contact-info">
                <div class="phone-contact-name">
                    ${escapeHtml(c.name)}
                    ${locked ? '<span class="phone-contact-badge">🔒 已锁定</span>' : ''}
                </div>
                <label class="phone-contact-prompt-label">外貌 tags（用于生图一致性）</label>
                <div class="phone-anchor-row">
                    <input class="phone-contact-anchor-edit phone-input" type="text"
                        data-name="${escapeHtml(c.name)}"
                        value="${escapeHtml(c.anchor?.prompt || '')}"
                        placeholder="如: long purple hair, fair skin, huge breasts"
                    >
                    ${hasContent ? `<button class="phone-btn phone-gen-appearance" data-name="${escapeHtml(c.name)}" title="AI 从世界书条目提取外貌 tags">✨ AI</button>` : ''}
                </div>
            </div>
            <div class="phone-contact-actions">
                <button class="phone-btn phone-gen-ref" data-name="${escapeHtml(c.name)}">
                    ${hasImg ? '换一张' : '生成参考图'}
                </button>
                ${hasImg ? `<button class="phone-btn phone-lock-ref" data-name="${escapeHtml(c.name)}">${locked ? '解锁' : '✅ 保持'}</button>` : ''}
                <button class="phone-btn phone-edit-source" data-name="${escapeHtml(c.name)}" title="改归属世界书">📍</button>
                <button class="phone-btn phone-remove-contact" data-name="${escapeHtml(c.name)}">移除</button>
            </div>
        </div>
    `;
}

// Wire button handlers after settings DOM is mounted
export function bindSettingsHandlers(root, {
    onImportContact, onGenRef, onLockRef, onRemoveContact, onModelChange, onComfyuiUrlChange,
    onToggleLore, onToggleWorldContext, onRefresh, onApiSave, onApiTest, onApiTriggerNow,
    onComfyuiTest, onFetchModels, onPromptEdit, onGenAppearance,
    onShowAllToggle, onBatchAssignOrphans, onDeleteOrphans, onImportFromOtherWorld,
    onEditContactSourceBook,
}) {
    // Section collapse — entire header is clickable (more discoverable than tiny ▶ icon).
    // Clicks on inner buttons/inputs are excluded so they still work normally.
    root.querySelectorAll('.phone-settings-header').forEach((header) => {
        header.addEventListener('click', (e) => {
            // Only the section-toggle button OR the bare h3 should toggle. Other inner
            // buttons (e.g. 🔄 refresh, ✏️ buttons) keep their own behavior.
            const target = e.target;
            const isInsideToggle = target.closest('.phone-section-toggle');
            const isInsideOtherBtn = target.closest('button:not(.phone-section-toggle)');
            const isHeaderItself = target === header;
            const isInsideH3 = target.closest('h3');
            if (!isInsideToggle && !isHeaderItself && !isInsideH3) return;
            if (isInsideOtherBtn && !isInsideToggle) return;

            const toggleBtn = header.querySelector('.phone-section-toggle');
            const id = toggleBtn?.dataset.section;
            if (!id) return;
            const body = root.querySelector(`.phone-section-body[data-section="${id}"]`);
            if (!body) return;
            const collapsed = body.classList.toggle('phone-collapsed');
            toggleBtn.textContent = collapsed ? '▶' : '▼';
            collapsed ? collapsedSections.add(id) : collapsedSections.delete(id);
        });
    });

    root.querySelectorAll('.phone-import-contact').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const uid = parseInt(btn.dataset.uid, 10);
            await onImportContact(uid, btn.dataset.book);
        });
    });
    root.querySelectorAll('.phone-gen-ref').forEach((btn) => {
        btn.addEventListener('click', () => onGenRef(btn.dataset.name, btn));
    });
    // Save edits to anchor prompt on blur or Enter
    root.querySelectorAll('.phone-contact-anchor-edit').forEach((inp) => {
        const save = () => onPromptEdit && onPromptEdit(inp.dataset.name, inp.value.trim());
        inp.addEventListener('blur', save);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); inp.blur(); } });
    });
    // Click reference image to show full-size in new tab
    root.querySelectorAll('.phone-contact-ref[src]').forEach((img) => {
        img.addEventListener('click', () => window.open(img.src, '_blank'));
    });
    root.querySelectorAll('.phone-gen-appearance').forEach((btn) => {
        btn.addEventListener('click', () => onGenAppearance && onGenAppearance(btn.dataset.name, btn));
    });
    root.querySelectorAll('.phone-lock-ref').forEach((btn) => {
        btn.addEventListener('click', () => onLockRef(btn.dataset.name));
    });
    root.querySelectorAll('.phone-remove-contact').forEach((btn) => {
        btn.addEventListener('click', () => onRemoveContact(btn.dataset.name));
    });
    // 📍 edit contact's sourceBook membership
    root.querySelectorAll('.phone-edit-source').forEach((btn) => {
        btn.addEventListener('click', () => onEditContactSourceBook && onEditContactSourceBook(btn.dataset.name));
    });
    // Contacts section: orphan banner + cross-world import + show-all toggle
    root.querySelector('#phone-batch-assign-btn')?.addEventListener('click', () => onBatchAssignOrphans && onBatchAssignOrphans());
    root.querySelector('#phone-orphans-delete-btn')?.addEventListener('click', () => onDeleteOrphans && onDeleteOrphans());
    root.querySelector('#phone-import-from-other-world-btn')?.addEventListener('click', () => onImportFromOtherWorld && onImportFromOtherWorld());
    root.querySelector('#phone-show-all-contacts')?.addEventListener('change', (e) => onShowAllToggle && onShowAllToggle(e.target.checked));
    root.querySelectorAll('.phone-toggle-lore').forEach((btn) => {
        btn.addEventListener('click', () => onToggleLore(parseInt(btn.dataset.uid, 10), btn.dataset.book));
    });
    root.querySelectorAll('.phone-toggle-wc').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!onToggleWorldContext) return;
            onToggleWorldContext({ uid: parseInt(btn.dataset.uid, 10), bookName: btn.dataset.book, name: btn.dataset.name || '' });
        });
    });
    const imgModelSel = root.querySelector('#phone-model-select');
    if (imgModelSel) imgModelSel.addEventListener('change', () => onModelChange(imgModelSel.value));
    const urlInput = root.querySelector('#phone-comfyui-url');
    if (urlInput) urlInput.addEventListener('change', () => onComfyuiUrlChange(urlInput.value, false));
    const urlMobileInput = root.querySelector('#phone-comfyui-url-mobile');
    if (urlMobileInput) urlMobileInput.addEventListener('change', () => onComfyuiUrlChange(urlMobileInput.value, true));
    const refreshBtn = root.querySelector('#phone-wb-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => onRefresh && onRefresh());

    // API config wiring
    const urlInput2 = root.querySelector('#phone-api-url');
    const keyInput = root.querySelector('#phone-api-key');
    const modelSel = root.querySelector('#phone-api-model');
    const modelCustom = root.querySelector('#phone-api-model-custom');
    const triggerSel = root.querySelector('#phone-api-trigger');
    const useMainCheckbox = root.querySelector('#phone-api-use-main');

    const getModelVal = () =>
        modelSel?.value === '__custom__'
            ? (modelCustom?.value?.trim() || '')
            : (modelSel?.value || '');

    const saveApi = () => {
        if (!onApiSave) return;
        onApiSave({
            url: urlInput2?.value?.trim() || '',
            key: keyInput?.value?.trim() || '',
            model: getModelVal(),
            triggerMode: triggerSel?.value || 'auto',
            useMainPreset: !!useMainCheckbox?.checked,
        });
    };

    if (modelSel) {
        modelSel.addEventListener('change', () => {
            if (modelCustom) {
                const custom = modelSel.value === '__custom__';
                modelCustom.style.display = custom ? 'block' : 'none';
                if (custom) modelCustom.focus();
            }
            saveApi();
        });
    }
    if (modelCustom) {
        modelCustom.addEventListener('change', saveApi);
        modelCustom.addEventListener('blur', saveApi);
    }
    [urlInput2, keyInput, triggerSel, useMainCheckbox].forEach((el) => {
        if (el) el.addEventListener('change', saveApi);
    });

    root.querySelectorAll('.phone-api-preset').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (urlInput2) urlInput2.value = btn.dataset.url || '';
            const m = btn.dataset.model || '';
            if (modelSel) {
                const opt = [...modelSel.options].find((o) => o.value === m);
                if (opt) {
                    modelSel.value = m;
                    if (modelCustom) modelCustom.style.display = 'none';
                } else {
                    modelSel.value = '__custom__';
                    if (modelCustom) { modelCustom.style.display = 'block'; modelCustom.value = m; }
                }
            }
            saveApi();
            if (keyInput) keyInput.focus();
        });
    });

    root.querySelector('#phone-api-test')?.addEventListener('click', () => onApiTest && onApiTest());
    root.querySelector('#phone-api-trigger-now')?.addEventListener('click', () => onApiTriggerNow && onApiTriggerNow());
    root.querySelector('#phone-api-fetch-models')?.addEventListener('click', async () => {
        if (!onFetchModels) return;
        const list = await onFetchModels();
        if (list && list.length && modelSel) {
            const current = getModelVal();
            const customOpt = modelSel.querySelector('option[value="__custom__"]');
            [...modelSel.options].forEach((o) => { if (o.value !== '__custom__') o.remove(); });
            list.forEach((m) => {
                const opt = document.createElement('option');
                opt.value = m; opt.textContent = m;
                if (m === current) opt.selected = true;
                modelSel.insertBefore(opt, customOpt);
            });
            if (!modelSel.value) modelSel.value = current || list[0];
            toastr.success(`拉取到 ${list.length} 个模型`);
        }
    });
    root.querySelector('#phone-comfyui-test')?.addEventListener('click', () => onComfyuiTest && onComfyuiTest());
}

export { upsertContact, removeContact, entryToContact };
