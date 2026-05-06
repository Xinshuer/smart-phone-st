# Smart Image Gen (酒馆扩展)

NSFW 感知 + 角色一致性的 ComfyUI 直连生图扩展。配合 [smart-phone](../smart-phone) 使用最佳，但单独装也能工作。

## 解决的核心痛点

> 用户:「给我看看你的小穴」
> 普通生图扩展:生成一张穿衣全身照 ❌
> Smart Image Gen:识别出 NSFW 意图 → 自动加 `pussy, spread legs, close-up` 等关键 tag → 生成正确画面 ✅

## 三大能力

### 1. NSFW 意图识别（[lib/nsfw-classifier.js](./lib/nsfw-classifier.js)）

扫描**最近一条用户消息**，按词典匹配输出 `{ level, tags }`：

| Level | 触发词示例 | 后果 |
|---|---|---|
| `sfw` | (默认) | 模型走标准 SFW 模式 |
| `suggestive` | 害羞 / 比基尼 / 大腿 / 锁骨 / 撩 | 加暗示性 tag，仍走 SFW 设定 |
| `explicit` | 小穴 / 自慰 / 内射 / 张开腿 / 裸 / 内裤 / 黑丝 | 走 NSFW 模式：模型 prompt 加显式 tag、负面去掉 nsfw、Pony 加 rating_explicit 前缀 |

视角/场景词也会自动追加到 tag：「自拍」→ `selfie`，「床上」→ `on bed, bedroom`，「特写」→ `close-up`，「镜子」→ `mirror selfie` 等。

### 2. 模型差异化 prompt 构造（[lib/prompt-builder.js](./lib/prompt-builder.js)）

按所选模型用对的 prefix / negative / 技术参数：

| 模型 | Prefix | 默认 NSFW 翻转 | CFG | Sampler | 尺寸 |
|---|---|---|---|---|---|
| **Pony Realism** | `score_9, score_8_up, score_7_up, photo, amateur, film grain` | NSFW 时加 `rating_explicit` | 6.5 | dpmpp_2m_sde + karras | 832×1216 |
| **NoobAI vPred** | `masterpiece, best quality, newest, absurdres, highres, real photo, photorealistic, ...` | **正面 +`nsfw`/`safe`、负面对称翻转**（NoobAI 强制） | 4.5 | euler + normal | 832×1216 |
| **majicMIX v7** | `Best quality, masterpiece, ultra high res, (photorealistic:1.4)` | — | 7.0 | euler_ancestral + karras | 768×1152 |

prompt 拼接顺序：`prefix + 角色锚点 + 意图 tag + AI 写的 prompt`，让用户的特写需求和角色外貌都不会被覆盖。

### 3. 角色一致性（[lib/character-anchor.js](./lib/character-anchor.js)）

从 smart-phone 读联系人：
- **未锁定** → seed 随机，外貌锚点 prompt 仍并入,保持基本五官/发色一致
- **已锁定** → seed 固定 + 锚点 prompt → 同一角色多次生图肉眼难分辨

## 安装

放到 `SillyTavern/public/scripts/extensions/third-party/smart-image-gen/`，刷新酒馆。

## 配置

扩展菜单点 **Smart Image Gen** 切换启用状态。具体的 ComfyUI URL / 模型选择在 **smart-phone 的设置面板**里改（两个扩展共享配置）。

如果不装 smart-phone，会用 `extension_settings.smart-image-gen` 的默认值（127.0.0.1:8188 / pony）。

## ComfyUI 同源问题

浏览器同源策略要求 ComfyUI 允许跨域。启动 ComfyUI 时加：

```bash
python main.py --enable-cors-header '*'
```

或把 ComfyUI 放在和酒馆同 host 的反向代理后。

## 工作流来源

3 个工作流模板已**内联**在 [lib/workflows.js](./lib/workflows.js)，与 `g:/本地部署/comfyUI生图工作流-*.txt` 一致。修改这个文件即可改 LoRA / 节点 / 默认参数。

## 公开 API

```js
// 生成单张图（用于 phone 内联）
const url = await window.smartImageGen.generateFromPicTag(
    '<pic prompt="1girl, smile">',
    { contacts: [...], hint: { from: '金琳' } }
);

// 生成参考图（用于角色锁定）
const { imageUrl, seed } = await window.smartImageGen.generateReferenceImage({
    characterName: '金琳',
    anchorPrompt: 'asian, long black hair, brown eyes, large breasts',
});

// 仅做意图分类（手动用）
const { level, tags } = window.smartImageGen.classifyIntent('给我看看你的小穴');
// → { level: 'explicit', tags: ['pussy', 'spread pussy', 'close-up'] }
```

## 调试

控制台搜 `[smart-image-gen]` 看日志。toastr 弹窗会提示意图等级和失败原因。
