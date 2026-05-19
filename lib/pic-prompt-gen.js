// v0.14.49 ⭐ Pass 2 — pic prompt 后台生成模块
// 设计目标：主 AI (Pass 1) 只出 SMS 文字 + <pic/> 占位符 → 输出 token 砍半 → 主消息速度
// 提升 50-60%。每个占位符再用 generateQuietPrompt 单独调 AI 生成聚焦的 booru prompt。
//
// 使用流程：
//   onMessageReceived 解析完 → 发现含 <pic/> 占位符的 SMS/GMSG/MOMENTS
//     → 调 generatePicPromptForContext({ targetName, smsContent, userText, contactAnchor, currentModel })
//     → 返回 booru prompt 字符串
//     → 填回 m.pic = `<pic prompt="${result}"/>` 写入 state
//     → 后续 triggerPicSlots 走标准路径出图
//
// 失败兜底：如果 generateQuietPrompt 抛错 / 返回空 / 返回明显不是 booru tag 的内容 →
//   返回简单 fallback prompt（"1girl, looking at viewer, indoor"）让 ComfyUI 至少出张图

import { buildPicPromptProtocol } from './protocol.js';

// 单标志锁定 — 防 generateQuietPrompt 并发调用（ST 用全局 abortController，并发会互相中断）
let _picGenLock = Promise.resolve();

// 从 AI 输出里抽 booru prompt — 防 AI 加 markdown 包装/前缀/解释文字
function extractBooruPrompt(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    let text = rawText.trim();
    // 剥 ```markdown 代码块
    text = text.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
    // 剥 <pic prompt="..."/> 包裹（万一 AI 又写了）
    const xmlMatch = text.match(/<pic[^>]*prompt="([^"]+)"/i);
    if (xmlMatch) return xmlMatch[1].trim();
    // 剥常见前缀 "Output:" / "Prompt:" / "以下是" / "Here is" 等
    text = text.replace(/^(?:output|prompt|以下是|here is|here'?s|booru[:：]?\s*prompt)[:：]?\s*/i, '');
    text = text.replace(/^[#*\->\s]+/, ''); // 列表/标题前缀
    // 取第一段非空内容（直到换行）
    const firstLine = text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
    // 如果有"Negative:"等额外段，砍掉
    const cleanLine = firstLine.split(/\s*Negative\s*[:：]/i)[0].trim();
    return cleanLine;
}

// 校验是否像 booru tag 列表（≥5 个逗号分隔的英文 tag）
function looksLikeBooruPrompt(text) {
    if (!text || typeof text !== 'string') return false;
    const tags = text.split(',').map(t => t.trim()).filter(Boolean);
    if (tags.length < 5) return false;
    // 至少一半 tag 是 ASCII（不允许全中文）
    const asciiTags = tags.filter(t => /^[a-zA-Z0-9_\s\-:\.\(\)]+$/.test(t));
    return asciiTags.length >= Math.ceil(tags.length / 2);
}

// 兜底 prompt — Pass 2 失败时确保 ComfyUI 至少能出图
const FALLBACK_PROMPT = '1girl, solo, looking at viewer, soft smile, indoor, soft lighting, casual';

/**
 * 调 ST 主 AI (quiet 模式) 生成单个 pic 的 booru prompt。
 * @param {Object} ctx
 * @param {string} ctx.targetName 角色名（联系人或 stranger NPC）
 * @param {string} ctx.smsContent SMS 文本内容（场景上下文）
 * @param {string} ctx.userText user 当前回合原话
 * @param {string} ctx.contactAnchor 角色视觉档案 (anchor.prompt 或 anchor.sdPrompt 头部) 提示给 AI 别重复
 * @param {string} ctx.currentModel 当前 SD 模型 id
 * @returns {Promise<string>} booru prompt 字符串（永不为空，失败返 FALLBACK_PROMPT）
 */
export async function generatePicPromptForContext({
    targetName = '',
    smsContent = '',
    userText = '',
    contactAnchor = '',
    currentModel = 'wai_anihentai',
} = {}) {
    // 串行锁定 — 多个 pic 排队跑，避免 abortController 互相中断
    const release = _picGenLock;
    let releaseNext;
    _picGenLock = new Promise(r => { releaseNext = r; });
    try {
        await release;
        return await _doGenerate({ targetName, smsContent, userText, contactAnchor, currentModel });
    } finally {
        releaseNext();
    }
}

async function _doGenerate({ targetName, smsContent, userText, contactAnchor, currentModel }) {
    const systemPrompt = buildPicPromptProtocol({
        targetName, smsContent, userText, contactAnchor, currentModel,
    });

    try {
        // ST 的 generateQuietPrompt 从 SillyTavern.getContext() 拿
        // 这个函数走主 AI（用户当前配置的模型），background 模式不影响主聊天显示
        const ctxApi = (typeof globalThis !== 'undefined' && globalThis.SillyTavern?.getContext)
            ? globalThis.SillyTavern.getContext()
            : null;
        if (!ctxApi?.generateQuietPrompt) {
            console.warn('[smart-phone v0.14.49 Pass 2] generateQuietPrompt 不可用，用 fallback prompt');
            return FALLBACK_PROMPT;
        }
        // 设标志告诉 onPromptReady 不要 push 协议 + strip
        // （Pass 2 不需要 PHONE 协议干扰，只要简洁 system prompt）
        window.__smartPhoneInternalQuietCall = true;
        let raw;
        try {
            raw = await ctxApi.generateQuietPrompt({
                quietPrompt: systemPrompt,
                skipWIAN: true,
                quietName: 'smart-phone-pic-prompt-gen',
            });
        } finally {
            window.__smartPhoneInternalQuietCall = false;
        }
        const extracted = extractBooruPrompt(raw);
        if (!looksLikeBooruPrompt(extracted)) {
            console.warn(`[smart-phone v0.14.49 Pass 2] AI 输出不像 booru prompt，用 fallback。raw="${raw?.slice(0, 200)}"`);
            return FALLBACK_PROMPT;
        }
        console.log(`[smart-phone v0.14.49 Pass 2] generated for "${targetName}": ${extracted.slice(0, 120)}…`);
        return extracted;
    } catch (err) {
        console.error('[smart-phone v0.14.49 Pass 2] failed:', err);
        return FALLBACK_PROMPT;
    }
}

// 批量处理多个 pic placeholder — 串行（generateQuietPrompt 不并发安全）
// 输入：picSlots[] 每个含 { ref, contextBuilder } — ref 是要被改写的对象（如 sms message），
//     contextBuilder 是返回 generatePicPromptForContext 入参的函数
// 返回：[{ ref, prompt }]
export async function batchGeneratePicPrompts(picSlots) {
    const results = [];
    for (const slot of picSlots) {
        const ctx = slot.contextBuilder();
        const prompt = await generatePicPromptForContext(ctx);
        results.push({ ref: slot.ref, prompt });
    }
    return results;
}
