// Settings app — worldbook import, contacts, model selection
import { load, save, upsertContact, removeContact } from '../state.js';
import { listClassifiedEntries, entryToContact } from '../worldbook.js';
import { API_PRESETS, MODEL_SUGGESTIONS } from '../phone-api.js';
import { escapeHtml } from '../util.js';

export async function renderSettings() {
    const s = load();
    const entries = await listClassifiedEntries();
    const characters = entries.filter((e) => e.type === 'character');
    const lores = entries.filter((e) => e.type === 'lore');

    return `
        <div class="phone-settings">

            <section class="phone-settings-section">
                <h3>📡 手机 API（独立于主聊天）</h3>
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
                <div class="phone-settings-actions">
                    <button id="phone-api-test" class="phone-btn">🔌 测试连接</button>
                    <button id="phone-api-trigger-now" class="phone-btn">⚡ 立即生成一次</button>
                </div>
            </section>

            <section class="phone-settings-section">
                <h3>生图模型</h3>
                <select id="phone-model-select" class="phone-select">
                    <option value="pony" ${s.imageGen.currentModel === 'pony' ? 'selected' : ''}>Pony Realism (欧美写实/默认)</option>
                    <option value="majicmix" ${s.imageGen.currentModel === 'majicmix' ? 'selected' : ''}>majicMIX v7 (亚洲写真)</option>
                    <option value="noobai" ${s.imageGen.currentModel === 'noobai' ? 'selected' : ''}>NoobAI vPred (动漫/暗调)</option>
                </select>
                <label class="phone-settings-row">
                    ComfyUI 地址
                    <input id="phone-comfyui-url" type="text" class="phone-input" value="${escapeHtml(s.imageGen.comfyuiUrl)}">
                    <span class="phone-settings-hint" style="margin-top:4px">手机端请填电脑局域网 IP，例如 <b>http://192.168.1.x:8188</b>（127.0.0.1 是手机本身）</span>
                    <button type="button" id="phone-comfyui-test" class="phone-btn phone-link-btn">🔌 测试 ComfyUI 连接</button>
                </label>
            </section>

            <section class="phone-settings-section">
                <div class="phone-settings-header">
                    <h3>世界书条目（${entries.length}）</h3>
                    <button id="phone-wb-refresh" class="phone-btn" title="重新扫描激活的世界书">🔄 刷新</button>
                </div>
                <p class="phone-settings-hint">读取自当前激活的世界书（全局 + 角色绑定 + 聊天绑定）。已自动按内容识别为人物 / 世界观。</p>

                <h4>👤 人物条目（${characters.length}）</h4>
                <div class="phone-wb-list">
                    ${characters.map(renderWbRow).join('') || '<div class="phone-empty-inline">无人物条目</div>'}
                </div>

                <h4>🌍 世界观条目（${lores.length}）</h4>
                <div class="phone-wb-list">
                    ${lores.map(renderWbRow).join('') || '<div class="phone-empty-inline">无世界观条目</div>'}
                </div>
            </section>

            <section class="phone-settings-section">
                <h3>联系人（${s.contacts.length}）</h3>
                <p class="phone-settings-hint">从人物条目导入后，可逐个生成参考图。锁定参考图后，后续涉及该角色的生图会复用同一外貌锚点。</p>
                <div class="phone-contact-list">
                    ${s.contacts.map(renderContactRow).join('') || '<div class="phone-empty-inline">尚无联系人</div>'}
                </div>
            </section>

        </div>
    `;
}

function renderWbRow(e) {
    return `
        <div class="phone-wb-row" data-uid="${e.uid}" data-book="${escapeHtml(e.bookName)}" data-type="${e.type}">
            <div class="phone-wb-text">
                <div class="phone-wb-comment">${escapeHtml(e.comment || '(无注释)')}</div>
                <div class="phone-wb-meta">📖 ${escapeHtml(e.bookName)}</div>
                <div class="phone-wb-preview">${escapeHtml(e.content)}…</div>
            </div>
            ${
                e.type === 'character'
                    ? `<button class="phone-btn phone-import-contact" data-uid="${e.uid}" data-book="${escapeHtml(e.bookName)}">导入联系人</button>`
                    : `<button class="phone-btn phone-toggle-lore" data-uid="${e.uid}" data-book="${escapeHtml(e.bookName)}">纳入上下文</button>`
            }
        </div>
    `;
}

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
                <button class="phone-btn phone-remove-contact" data-name="${escapeHtml(c.name)}">移除</button>
            </div>
        </div>
    `;
}

// Wire button handlers after settings DOM is mounted
export function bindSettingsHandlers(root, { onImportContact, onGenRef, onLockRef, onRemoveContact, onModelChange, onComfyuiUrlChange, onToggleLore, onRefresh, onApiSave, onApiTest, onApiTriggerNow, onComfyuiTest, onFetchModels, onPromptEdit, onGenAppearance }) {
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
    root.querySelectorAll('.phone-toggle-lore').forEach((btn) => {
        btn.addEventListener('click', () => onToggleLore(parseInt(btn.dataset.uid, 10), btn.dataset.book));
    });
    const imgModelSel = root.querySelector('#phone-model-select');
    if (imgModelSel) imgModelSel.addEventListener('change', () => onModelChange(imgModelSel.value));
    const urlInput = root.querySelector('#phone-comfyui-url');
    if (urlInput) urlInput.addEventListener('change', () => onComfyuiUrlChange(urlInput.value));
    const refreshBtn = root.querySelector('#phone-wb-refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', () => onRefresh && onRefresh());

    // API config wiring
    const urlInput2 = root.querySelector('#phone-api-url');
    const keyInput = root.querySelector('#phone-api-key');
    const modelSel = root.querySelector('#phone-api-model');       // now a <select>
    const modelCustom = root.querySelector('#phone-api-model-custom'); // revealed when "自定义…"
    const triggerSel = root.querySelector('#phone-api-trigger');

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
        });
    };

    // Select change: show/hide custom input
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
    [urlInput2, keyInput, triggerSel].forEach((el) => {
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
