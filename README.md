# smart-phone-st

SillyTavern 自研的两个配套扩展，把"手机 UI + 智能生图"塞进酒馆：

- **smart-phone** — 手机界面浮窗，4 app（消息 / 论坛 / 小红书 / 设置），独立手机 API（DeepSeek 等），世界书读取分类，联系人参考图（角色一致性锚点）
- **smart-image-gen** — NSFW 感知生图，ComfyUI 直连（Pony Realism / NoobAI vPred / majicMIX 三模型路由），角色锁定 seed，按用户意图触发裸露/服装/姿势 tag

两个扩展独立加载，运行时通过 `window.smartPhone` / `window.smartImageGen` 互通。

## 功能亮点

### smart-phone
- 浮窗手机 UI，iOS 风浅色主题，可拖动
- 主聊天只显示 📱 占位符，正文走 XML `<PHONE>` 协议块（mochi 风格）
- 世界书自动分类（人物 / 世界观），一键导入联系人
- 联系人参考图工作流：✨ AI 从世界书提取外貌 booru tags → 生成参考图 → ✅ 保持锁定
- 手机 API 独立配置（DeepSeek 等便宜模型），不消耗主聊天的 context
- 消息 / 论坛 / 小红书三大 app + 设置页

### smart-image-gen
- ComfyUI 直连（POST /prompt + 轮询 /history + /view）
- 三模型工作流模板内联（无需外部 json 文件）
- 中文 NSFW 词典 → 英文 booru tag 自动映射（"奶子" → topless / breasts out / nipples 等）
- SFW 默认守门：用户没显式触发 NSFW 时自动剥离 AI 偷塞的裸露词
- 锁定角色 → 复用同一 seed + 完整 SD prompt，跨消息保持外貌一致

## 安装

```
克隆到 SillyTavern 扩展目录：
git clone https://github.com/Xinshuer/smart-phone-st.git
然后把 smart-phone/ 和 smart-image-gen/ 分别复制到：
SillyTavern/public/scripts/extensions/third-party/
```

或者直接把 `smart-phone/` 和 `smart-image-gen/` 这两个文件夹拷到上述路径。重启酒馆 → 扩展菜单里勾选启用。

## ComfyUI 配置

需要本地 ComfyUI 启动时加 `--enable-cors-header *`，否则浏览器 fetch 会被 CORS 拦：

```bat
python main.py --enable-cors-header *
```

详细工作流接入说明见 `docs/工作流接入指南.md`。

## 协议

XML 标签格式（mochi 风格），主 AI 输出 `<PHONE>...</PHONE>` 块，扩展解析后路由到对应 app：

```xml
<PHONE>
  <SMS from="角色名" time="13:45">短信内容 <pic prompt="elegant pose, garden background"></pic></SMS>
  <MOMENT from="..." time="..."><![CDATA[朋友圈正文]]></MOMENT>
  <FORUM .../>
  <XHS .../>
</PHONE>
```

完整协议在 `smart-phone/lib/protocol.js`。

## 许可

MIT
