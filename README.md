# Smart Phone (酒馆扩展)

Abstract 风格的单轨 YAML 协议手机 UI 扩展，配合 [smart-image-gen](../smart-image-gen) 一起使用可获得带角色一致性的 NSFW 感知生图。

## 快速安装

把 `smart-phone/` 整个目录放到酒馆的 `public/scripts/extensions/third-party/` 下：

```
SillyTavern/
└── public/scripts/extensions/third-party/
    ├── smart-phone/        ← 本目录
    └── smart-image-gen/    ← 配套生图扩展（可选但强推）
```

刷新酒馆，扩展菜单 (右上角拼图图标) 会出现 **Smart Phone** 入口。

## 4 个 App

| App | 功能 |
|---|---|
| 💬 消息 | 私聊列表 + 单条会话视图，支持文字/sticker/voice/红包/图片消息 |
| 📋 论坛 | BBS 风格帖子流，按板块 (摄影/科技/情感/八卦/...) 营造世界感 |
| 🐦 微博 | 微博风短动态，点赞数、评论数、配图 |
| ⚙️ 设置 | 世界书条目自动分类 / 联系人导入 / 生图模型切换 / ComfyUI 配置 |

## 协议设计

每轮 AI 回复**只输出**一个 ` ```phone ` YAML 块。chat 主区域不会显示任何叙事 prose——手机 UI 是唯一可视化产物。

```yaml
phone:
  date: 2026-05-06
  time: 14:32
  messages:
    - from: 金琳
      type: text
      content: 在干什么
      time: 14:32
    - from: 金琳
      type: text
      content: 刚在家躺着刷视频呢，有点无聊~
      time: 14:33
      pic: <pic prompt="1girl, lying on bed, casual, warm light">
  weibo:
    - author: 金琳
      content: 周末窝家里晒太阳
      pic: <pic prompt="1girl, sunlight, balcony, candid">
      time: 14:35
      likes: 23
  forum:
    - board: 摄影区
      author: 网友A
      title: 今天的城市夜景
      content: 头一次在这条天桥拍出感觉
      time: 14:30
```

## 世界书自动分类

进入 `设置` tab，扩展会自动扫描当前激活的世界书条目，按内容启发式分类：

- 👤 **人物条目** — 含「姓名 / 年龄 / 外貌 / 性格」等字段，可一键导入为联系人
- 🌍 **世界观条目** — 含「世界观 / 历史 / 法则 / 经济 / 政治」等字段，可纳入对话上下文

分类标准基于关键字打分；如果错分可手动覆盖。

## 联系人 + 角色一致性

导入联系人后：
1. 扩展从原条目里提取**外貌锚点**（中→英标签转换：黑发→`black hair`，巨乳→`large breasts`，亚洲→`asian` 等）
2. 点 **生成参考图** → smart-image-gen 出一张该角色的肖像
3. 看着满意点 **锁定** → 之后所有涉及该角色的生图都会复用这个锚点 + seed，保持外貌一致
4. 不满意点 **重新生成** 即可换种子

## 与 smart-image-gen 的协作

智能生图扩展会自动接管 YAML 中的 `pic` 字段或正文里的 `<pic prompt="...">` 标签。区别于通用的 st-image-auto-generation：

| 能力 | st-image-auto-generation | smart-image-gen |
|---|---|---|
| `<pic>` 标签拦截 | ✅ | ✅ |
| 调用 ST 自带 `/sd` | ✅ | ❌（直接 POST ComfyUI） |
| **NSFW 意图识别** | ❌ | ✅ 解析最近用户消息，加 pussy/spread legs 等关键 tag |
| **角色一致性** | ❌ | ✅ 锁定 seed + 锚点 prompt |
| 多模型路由 | ❌ | ✅ Pony / NoobAI / majicMIX |
| 模型差异化 prompt | ❌ | ✅ NoobAI 的 safe/nsfw 翻转、Pony 的 score_9 前缀等 |

## ComfyUI 配置

设置面板默认 `http://127.0.0.1:8188`。自带 3 个工作流（Pony / NoobAI vPred / majicMIX v7），与 `g:/本地部署/comfyUI生图工作流-*.txt` 内容一致。

注意：扩展用 fetch 直接 POST ComfyUI，所以浏览器要么和 ComfyUI 同源，要么 ComfyUI 要开 CORS（`--enable-cors-header '*'` 启动）。

## 已知限制

- YAML 解析器只支持基础语法（map / list / 标量）；缩进必须用空格
- 当前没有头像上传，联系人头像用名字首字
- 论坛/微博的"自动 NPC 帖"完全靠 AI 主动产生，没有强制频率
- 没做手机锁屏 / 通知中心 / 来电 / 拨号 / 邮件等次级 app（按使用频率优先级，后续可加）

## 开发笔记

- `lib/protocol.js` - YAML 解析 + 协议提示词构造
- `lib/state.js` - 持久化状态（按 chatId 分组）
- `lib/worldbook.js` - 世界书条目分类 + 中→英外貌提取
- `lib/apps/*.js` - 各 app 的渲染函数
- `index.js` - 挂载 / 事件 / 路由
