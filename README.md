# Smart Phone — SillyTavern 扩展

把"手机 UI"塞进 SillyTavern：浮窗手机界面，4 个 app（消息 / 论坛 / 小红书 / 设置），独立手机 API（DeepSeek 等便宜模型），世界书读取分类，联系人参考图（角色一致性锚点）。

配套 NSFW 感知生图扩展 → [smart-image-gen-st](https://github.com/Xinshuer/smart-image-gen-st)（可选，不装也能跑，只是 `<pic>` 不会自动生图）。

## 功能亮点

- **浮窗手机 UI** — iOS 风浅色主题，可拖动；主聊天只显示 📱 占位符，正文走 `<PHONE>` XML 协议块（mochi 风格）
- **世界书自动分类** — 人物 / 世界观条目智能识别，一键导入联系人
- **联系人参考图工作流** — ✨ AI 从世界书提取外貌 booru tags（DeepSeek V4 / R1 推荐）→ ComfyUI 生成参考图 → ✅ 保持锁定 → 后续聊天生图自动复用 seed + 同一外貌
- **手机 API 独立配置** — DeepSeek / OpenAI 兼容，不消耗主聊天的 context window
- **三大 app + 设置页** — 消息 / 论坛 / 小红书

## 安装

### ST 扩展菜单一键装（推荐）

1. SillyTavern 扩展菜单 → 安装扩展（URL）
2. 填入：`https://github.com/Xinshuer/smart-phone-st`
3. 安装后重启酒馆，扩展菜单里勾选启用

### 手动安装

```bash
cd SillyTavern/data/default-user/extensions/
git clone https://github.com/Xinshuer/smart-phone-st.git
```

## 协议

主 AI 输出 `<PHONE>...</PHONE>` 块，扩展解析后路由到对应 app：

```xml
<PHONE>
  <SMS from="角色名" time="13:45">短信内容 <pic prompt="elegant pose, garden background"></pic></SMS>
  <MOMENT from="..." time="..."><![CDATA[朋友圈正文]]></MOMENT>
  <FORUM .../>
  <XHS .../>
</PHONE>
```

完整协议见 `lib/protocol.js`。

## 配套生图扩展

`<pic>` 标签由 [smart-image-gen-st](https://github.com/Xinshuer/smart-image-gen-st) 拦截并送 ComfyUI 渲染。需要本地 ComfyUI 启动时加 `--enable-cors-header *`：

```bat
python main.py --enable-cors-header *
```

不装这个生图扩展也能用，只是 `<pic>` 标签不会变成图片。

## 许可

MIT
