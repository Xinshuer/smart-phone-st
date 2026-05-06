# 项目交接文档 — smart-phone + smart-image-gen 自研扩展

**截至 2026-05-06（第二轮）**。下一个 Claude 接手时，先读这份 + `工作流接入指南.md`。

---

## 1. 总目标

用户在自研两个 SillyTavern 扩展替代 Abstract外置手机(作者失联):

- `smart-phone/` — 手机 UI 浮窗，4 app：消息（含子tab）/论坛/小红书/设置
- `smart-image-gen/` — NSFW 感知 + 角色一致性 + ComfyUI 直连生图

---

## 2. 文件位置（关键！）

**实际部署位置**（⚠️ 改代码改这里，不是 g:\插件\ 下）：
- `g:\SillyTavern\public\scripts\extensions\third-party\smart-phone\`
- `g:\SillyTavern\public\scripts\extensions\third-party\smart-image-gen\`

**ComfyUI**：
- `g:\本地部署\ComfyUI\启动ComfyUI.bat` — 已加 `--enable-cors-header *`
- 三个工作流文件 `g:\本地部署\comfyUI生图工作流-{pony-realism,noobai-vpred,majicmix}.txt`

---

## 3. 当前架构

### smart-phone

```
manifest.json
index.js                — 主入口，事件路由，所有 handle* 函数
style.css               — iOS 风浅色，可拖动浮窗
lib/
  protocol.js           — XML 标签解析 + 协议提示词
  state.js              — 持久化（extension_settings.smartPhone）
  worldbook.js          — 世界书 API 合并 + 分类 + 中→英外貌翻译
  phone-api.js          — 独立 OpenAI 兼容 API（DeepSeek 等）
  xhs-api.js            — 小红书陌生人评论 + 随机帖子生成
  util.js               — escapeHtml 等工具
  apps/
    messages.js         — 聊天列表 + 会话视图 + 【👤联系人子tab】
    forum.js            — BBS 论坛
    xhs.js              — 小红书瀑布流
    settings.js         — API配置 / 生图模型 / 世界书导入 / 联系人管理
```

### smart-image-gen

```
manifest.json
index.js                — 主入口，拦截 <pic>（跳过 PHONE 块），暴露 window.smartImageGen
lib/
  nsfw-classifier.js    — 中文词典 → English booru tags + level
  prompt-builder.js     — 按模型拼 prompt（NoobAI 已更新亮调 prefix + 抗暗调 negative）
  character-anchor.js   — resolveContact / getAnchorBundle
  comfyui-bridge.js     — POST /prompt + 轮询 /history + /view
  workflows.js          — 3 工作流模板内联（NoobAI 已更新 RescaleCFG + cfg=7.0 + LoRA=0.5）
```

---

## 4. 本轮已交付的修改（v0.4.0）

### 图片质量修复

**`smart-image-gen/lib/workflows.js` — NoobAI 模板**：
- ✅ 新增 node `"101"` (RescaleCFG, multiplier=0.7) — 修暗调的关键
- ✅ node `"2"` (LoraLoader) 的 model 来源改为 `["101", 0]`（原来是 `["100", 0]`，绕过了 RescaleCFG）
- ✅ LoRA strength_model/clip 1.0 → 0.5
- ✅ KSampler cfg 4.5 → 7.0
- ✅ FaceDetailer cfg 4.5 → 7.0

**`smart-image-gen/lib/prompt-builder.js` — NoobAI 提示词**：
- ✅ 亮调 prefix 加入 `sharp focus, bright, well-lit, daylight, high-key lighting, natural lighting`
- ✅ negative 加入 `dark, dim, low light, underexposed, monochrome, dark room, app interface, status bar, ui, app screenshot, phone screen frame, social media overlay`
- ✅ TECH.noobai.cfg 4.5 → 7.0

### 图片缓存 / 重复生成修复

**`smart-phone/index.js`**：
- ✅ 新增 `picUrlCache = new Map()` — tab 切换 / 新消息到来时不再重新生成旧图
- ✅ `triggerPicSlots` 先查 cache；命中则直接 innerHTML 插图，不发 ComfyUI 请求
- ✅ `triggerPicSlots` 传 `hint: { from: currentThread }` — 角色锁定 seed 现在实际生效

**`smart-image-gen/index.js`**：
- ✅ `onMessageReceived` 先剥离 `<PHONE>` 块再扫 `<pic>` — 消除双重生成（原来每张图会生成两次）

### 消息 tab 子tab

**`smart-phone/lib/apps/messages.js`**：
- ✅ 新增 `renderMessagesSubTabs(subTab)` — 渲染 `[💬 聊天 | 👤 联系人]` 子tab 头
- ✅ 新增 `renderContactsTab()` + `renderContactCard(c)` — 联系人管理 UI（在消息 tab 内直接可用）
- ✅ 消息列表头像：有参考图的联系人用参考图作 avatar（onerror 回退到首字）
- ✅ 会话头部也显示联系人头像 + 🔒 图标

**`smart-phone/index.js`**：
- ✅ 新增 `currentMessagesSubTab = 'chats'` 状态
- ✅ rerender() 路由子 tab
- ✅ 子 tab 切换不重置 currentThread；切换主 tab 时重置子 tab 为 'chats'

### 联系人参考图工作流改进

**`smart-phone/lib/apps/settings.js` + `messages.js`**：
- ✅ anchor prompt 改为可编辑 `<input>`（原来只读 `<code>`）
- ✅ 旁边新增 `✨ AI` 按钮 → 调用手机 API 从世界书内容生成 booru 外貌 tags
- ✅ "锁定" 改为 "✅ 保持"，更直观
- ✅ 参考图缩略图可点击 → 新标签页查看大图
- ✅ `handleGenRef` 新增按钮 loading 状态（`⏳ 生成中…` + disabled）

**`smart-phone/index.js`**：
- ✅ `handleGenerateAppearance` — 直接 fetch chat/completions（不用 callPhoneApi，可暴露真实错误）
- ✅ max_tokens 300（原 150 太短会截断）
- ✅ `handlePromptEdit` — 保存手动编辑的 anchor prompt

---

## 5. 当前状态 / 待验证

| 项 | 状态 |
|---|---|
| NoobAI 图片质量（亮调） | ✅ 已修复（RescaleCFG + cfg=7.0 + 亮调 prefix） |
| tab 切换不重新生成 | ✅ picUrlCache 修复 |
| 旧图不被新图覆盖 | ✅ picUrlCache 修复 |
| 双重生成消除 | ✅ smart-image-gen 跳过 PHONE 块 |
| 角色锁定 seed 实际生效 | ✅ hint.from 修复 |
| ✨ AI 外貌生成 | ⚠️ 用户点击后报"生成失败"，但 API 已配置 — 已改直接 fetch 暴露真实错误，待用户测试 |
| 消息子 tab 功能 | ✅ 代码已写，待用户实测 |
| 论坛 tab | ❓ 仍无数据（AI 不主动生成 FORUM 标签） |
| 小红书陌生人评论 | ❓ 依赖 phone API，未复测 |

---

## 6. ✨ AI 外貌生成 — 调试指引

用户点 ✨ 报"生成失败"，现在 toastr 会显示真实错误信息（`API 402: ...`/`API 401: ...` 等）。

常见原因：
1. **API 余额不足**（DeepSeek 402）— 充值
2. **模型名错误**（400 model not found）— 在设置里改模型名，如 `deepseek-chat`
3. **Key 过期或错误**（401）— 重新填 Key
4. **rawContent 为空** — 联系人是旧版导入的（没有 rawContent 字段），需要重新从世界书导入

`contact.rawContent` 在 `entryToContact()` 里设置，只有通过「导入联系人」按钮导入的才有。旧版 state 里的联系人可能缺这个字段。

---

## 7. 联系人参考图完整工作流

1. 设置 → 世界书条目 → 点「导入联系人」（此时 rawContent 被保存）
2. 消息 → 👤 联系人 子tab → 找到该联系人
3. 点 **✨** → DeepSeek 读世界书 → 填入外貌 tags（如 `long purple hair, fair skin, huge breasts, narrow waist`）
4. 手动微调 tags（可加 `k-cup, mature female, asian` 等）
5. 点 **生成参考图** → ComfyUI 生成肖像（约 15s）
6. 满意 → 点 **✅ 保持** → 角色锁定 🔒
7. 之后在该角色对话里触发的所有 `<pic>` 都自动附加外貌 tags + 固定 seed

---

## 8. 下一个 Claude 接手该做什么

1. 先问用户 ✨ AI 外貌生成的报错是什么（现在会显示真实错误了）
2. 如果 API 错误 → 根据错误码引导用户检查配置
3. 如果 `rawContent 为空` → 让用户重新「导入联系人」
4. 验证完 ✨ 后，测试完整链路：✨ AI外貌 → 生成参考图 → ✅保持 → 聊天触发 `<pic>` → 图片一致
5. 次级：论坛数据（加 `<FORUM>` 标签或用 phone API 刷）

---

## 9. 关键文件直链

- 主入口: `g:\SillyTavern\public\scripts\extensions\third-party\smart-phone\index.js`
- 协议: `g:\SillyTavern\public\scripts\extensions\third-party\smart-phone\lib\protocol.js`
- 消息/联系人 tab: `g:\SillyTavern\public\scripts\extensions\third-party\smart-phone\lib\apps\messages.js`
- 设置: `g:\SillyTavern\public\scripts\extensions\third-party\smart-phone\lib\apps\settings.js`
- ComfyUI bridge: `g:\SillyTavern\public\scripts\extensions\third-party\smart-image-gen\lib\comfyui-bridge.js`
- 工作流模板: `g:\SillyTavern\public\scripts\extensions\third-party\smart-image-gen\lib\workflows.js`
- NSFW 词典: `g:\SillyTavern\public\scripts\extensions\third-party\smart-image-gen\lib\nsfw-classifier.js`
- prompt 构建: `g:\SillyTavern\public\scripts\extensions\third-party\smart-image-gen\lib\prompt-builder.js`
- 工作流文档: `g:\插件\工作流接入指南.md`
