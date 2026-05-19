// v0.14.59 ⭐⭐⭐ 真正并行 — 跟 thinking 完全并行的图片预生成
// 思路：GENERATION_STARTED 时（主 AI 还在 thinking）立即用 user 文本启动 phone-api 生成
// booru prompt，然后立即 fire ComfyUI。主 AI thinking 完输出 PHONE 块时，图大概率已 ready。
//
// 跟旧的 stream-prefire 区别：
//   旧：等 stream 出现 <pic prompt=.../> 才 fire → thinking 模型场景跟主消息几乎串联
//   新：完全不等 AI，独立预生成 → 跟 thinking 真并行 → 节省 25-40% 总等待
//
// 适用场景：user 普通要图（"发自拍/发图/穿搭/看看你"）。AV 多镜头复杂叙事跳过预生成
// （让 stream-prefire 作 fallback，AI 决定 STAGE 序列）。

import { callPhoneApi } from './phone-api.js';
import { buildPicPromptProtocol } from './protocol.js';

// 启发式分析 user 文本意图
// 返回 { wantsPic, count, mode, sceneHint }
//   mode: 'normal' (普通要图) / 'av' (AV 多镜头，跳过预生成) / 'skip' (不要图)
export function analyzeUserIntent(text) {
    if (!text || typeof text !== 'string') return { wantsPic: false, count: 0, mode: 'skip' };

    // 强 NSFW 多镜头关键词 → AV 模式跳过预生成（让 AI 出 STAGE 序列）
    const AV_RE = /(操她|操你|插进|插入|内射|颜射|口爆|轮奸|gangbang|groupsex|双龙|多人|调教|奴役|玩弄|蹂躏|凌辱|榨干|大战|啪啪|做爱|啪她|啪他|sex(?:ed|ing)?|fuck|肛交|后入|骑乘|后入|颜面骑乘)/i;
    if (AV_RE.test(text)) return { wantsPic: false, count: 0, mode: 'av' };

    // 普通图片关键词
    const PIC_RE = /(照片|相片|图片|图像|拍照|拍张|拍个|拍组|拍.{0,5}张|拍.{0,5}相|拍腿|拍奶|拍胸|拍屁股|拍小穴|拍逼|拍阴|拍脚|拍脸|拍全身|拍背|拍脖|拍肩|拍腰|拍上半身|拍下半身|发图|发照|发张|发一张|发几张|发个图|发一组|发自拍|发个|发组|看看你|看看她|看看妈|看看姐|看看你的|看看她的|看看妈的|看看姐的|给我看|让我看|让.{1,3}看|让大家看|让他们看|让他看|让她看|自拍|穿搭|镜子前|视频|录像|直播|走光|露(?:点|奶|逼|穴|胸|屁股)|脱.{0,3}拍|脱了发|show me|selfie)/i;
    if (!PIC_RE.test(text)) return { wantsPic: false, count: 0, mode: 'skip' };

    // 张数检测
    // 数字 "5张/三张/拍5张"
    let count = 1;
    const digitMatch = text.match(/(\d+)\s*张/);
    if (digitMatch) {
        count = Math.min(parseInt(digitMatch[1], 10) || 1, 5);
    } else {
        const zhNumMap = { '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5 };
        const zhMatch = text.match(/([一两二三四五])\s*张/);
        if (zhMatch) count = zhNumMap[zhMatch[1]] || 1;
        else if (/几张|多张|几组|一组/.test(text)) count = 3;
    }

    // 场景提示（喂 phone-api）
    const sceneHints = [];
    if (/自拍|selfie/i.test(text)) sceneHints.push('selfie');
    if (/穿搭/.test(text)) sceneHints.push('outfit display');
    if (/镜子/.test(text)) sceneHints.push('mirror selfie');
    if (/腿|legs/i.test(text)) sceneHints.push('legs focus');
    if (/奶|胸|breast/i.test(text)) sceneHints.push('breast focus');
    if (/屁股|ass/i.test(text)) sceneHints.push('ass focus');
    if (/小穴|逼|pussy/i.test(text)) sceneHints.push('pussy focus');
    if (/脚|feet/i.test(text)) sceneHints.push('feet focus');

    return {
        wantsPic: true,
        count,
        mode: 'normal',
        sceneHint: sceneHints.join(', '),
    };
}

// 推断当前回合的 target 角色
// 优先级：1) user 文本明确提到的角色名 2) 当前 thread（单聊就是联系人本身）
export function inferTarget({ chatId, currentThread, isGroupThread, userText, contacts, getActiveGroups, findGroup }) {
    // 1) user 文本里有"@某某"或"找某某"
    const allNames = contacts.map(c => c.name);
    for (const name of allNames) {
        if (!name) continue;
        if (userText.includes(name)) return name;
    }

    // 2) 当前 thread
    if (currentThread) {
        if (!isGroupThread(currentThread)) {
            // 单聊 thread 就是联系人名
            return currentThread;
        } else {
            // 群聊：取群里第一个成员（粗糙启发）
            const group = findGroup(currentThread);
            if (group?.members?.length) {
                return group.members[0].nameSnapshot || group.members[0].name || '';
            }
        }
    }

    return '';
}

// 调 phone-api 生成 booru prompt（独立通道，不卡主 AI）
// 跟 pic-prompt-gen.js 的 generatePicPromptViaPhoneApi 类似但更宽松（允许 fallback）
async function _genOnePrompt({ userText, target, anchor, sceneHint, currentModel }) {
    const systemPrompt = buildPicPromptProtocol({
        targetName: target,
        smsContent: sceneHint || userText, // sceneHint 作为虚拟 SMS context
        userText,
        contactAnchor: anchor,
        currentModel,
    });
    const userInput = `角色：${target}\nuser 原话：${userText}\n场景关键词：${sceneHint || '由你判断'}\n\n输出 1 行英文 booru prompt：`;
    try {
        const raw = await callPhoneApi(userInput, systemPrompt, {
            useFallback: false, // 不走 ST generateRaw（会跟主 AI 抢 abortController）
            temperature: 0.6,
        });
        if (!raw) return null;
        // 抽 booru prompt（剥 markdown / xml / 前缀）
        return _extractBooruPrompt(raw);
    } catch (err) {
        console.warn('[smart-phone v0.14.59 pre-fire] phone-api 调用失败:', err);
        return null;
    }
}

function _extractBooruPrompt(rawText) {
    if (!rawText) return '';
    let text = String(rawText).trim();
    text = text.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
    const xmlMatch = text.match(/<pic[^>]*prompt="([^"]+)"/i);
    if (xmlMatch) return xmlMatch[1].trim();
    text = text.replace(/^(?:output|prompt|以下是|here is|here'?s|booru[:：]?\s*prompt)[:：]?\s*/i, '');
    text = text.replace(/^[#*\->\s]+/, '');
    const firstLine = text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
    return firstLine.split(/\s*Negative\s*[:：]/i)[0].trim();
}

// 主入口：预生成 N 张图，返回 Promise<URL>[]（每个 Promise 独立 fire）
// fire 之后不 await — 让 caller 存到模块状态，等 onMessageReceived 时再 await
export async function prefirePics({
    userText,
    target,
    anchor,
    count,
    sceneHint,
    currentModel,
    smartImageGen, // window.smartImageGen
    contacts,
}) {
    if (!smartImageGen?.generateFromPicTag) return [];
    if (count <= 0) return [];

    // 并行生成 N 个 prompt（phone-api 独立通道，互不阻塞）
    const promptPromises = [];
    for (let i = 0; i < count; i++) {
        promptPromises.push(_genOnePrompt({ userText, target, anchor, sceneHint, currentModel }));
    }
    const prompts = await Promise.all(promptPromises);

    // 每个 prompt 立即 fire ComfyUI（不 await，让 caller 拿 Promise<URL>）
    const urlPromises = [];
    const fireStart = Date.now();
    for (const prompt of prompts) {
        if (!prompt) {
            console.warn('[smart-phone v0.14.60] ⚠️ pre-fire prompt 为 null，跳过 ComfyUI fire');
            urlPromises.push(Promise.resolve(null));
            continue;
        }
        const safePrompt = prompt.replace(/"/g, '&quot;');
        const tempPicTag = `<pic prompt="${safePrompt}"/>`;
        const hint = { from: target, source: 'sms' };
        const fireIdx = urlPromises.length;
        const p = smartImageGen.generateFromPicTag(tempPicTag, { contacts, hint })
            .then((url) => {
                const elapsed = ((Date.now() - fireStart) / 1000).toFixed(1);
                console.log(`[smart-phone v0.14.60] ✅ pre-fire #${fireIdx} ComfyUI 完成 (${elapsed}s, target=${target})`);
                return url;
            })
            .catch((err) => {
                console.warn(`[smart-phone v0.14.60] ❌ pre-fire #${fireIdx} ComfyUI 失败:`, err);
                return null;
            });
        urlPromises.push(p);
        console.log(`[smart-phone v0.14.60] ⚡ pre-fire #${fireIdx} ComfyUI 已 fire (target=${target}, prompt=${prompt.slice(0, 60)}…)`);
    }
    return urlPromises;
}
