# Telegram Hub UI 实施规范 (Hand-off Plan)

这份文档专门为 Codex Bridge 的运行卡片 (Hub) 制定了核心 UI 规则和呈现形式。后续其他 Agent 可以完全依照此文档进行渲染层代码 ([ui-runtime.ts](file:///Users/tuziliji/projects/telegram-codex-bridge/src/telegram/ui-runtime.ts) 或对应视图文件) 的实装，无需关心设计过程。

---

## 核心设计理念
**“出海分块 (Section Separator) + 优雅折叠 (<blockquote expandable>)”**
- 舍弃原先的紧凑无间隔列表。
- 利用特定的横线长度划分各个会话的物理区块，以此在复杂状态下维持信息的极度清晰和隔离感。
- 利用 Telegram 官方的原生折叠特性，收纳多行长文本日志/进度。

## UI 规范详情

### 1. 全局分割线 (Divider)
- **使用的字符与长度**：`━━━━━━━━━━━━━━━━━━`（18个全角 `━` 字符组合）。
- **制定原因**：经过手机端和桌面端的主流分辨率测试，18个全角字符是**黄金长度**。它能够在主流窄屏手机上完美铺开而**不会发生换行断裂**，同时在电脑端具有较强的视觉存在感，能完美充当水平分割线 (Horizontal Rule) 的作用。

### 2. 长文体容器 (Responsive Long-text)
- **使用的 HTML 标签**：Telegram 原生的 `<blockquote expandable>` 标签。
- **排版结构**：将所有的会话进度预览 (Preview/Log) 用该标签闭包，并单独放在该区块的末尾，上方保留一个诸如 `<b>[Runtime Preview]</b>` 的小标题作为引导。
- **制定原因**：用户日志可能多达几百字，如果直接铺开，在手机上会疯狂挤占整屏高度，导致 Hub 卡片完全无法阅读。`<blockquote expandable>` 在初次渲染时会自动将文本截断为几行，并附带左侧极具设计感的高亮指示线。用户手动点击时才会优雅伸缩，视觉效果极佳。

### 3. 层级与字体排版 (Typography & Syntax)
- **概览标题**：用粗体标明当前的目录进度 `🎯 <b>Active Hub</b> [目录: 1/1]`
- **Session 标题**：状态图标 + 编号 + 粗体名称，如 `🟢 <b>SESSION #4: telegram-codex-bridge</b>`
- **Session 元数据**：必须使用斜体以弱化视觉重要性：`<i>(Folder: custom-project-folder)</i>`。
- **状态徽章要求 (Status Badges)**：
  - 运行中 (Running)：使用 `🟢`
  - 后台挂起/被动运行 (Background/Paused)：使用 `🟡`
  - 已完成 (Completed/Archived)：使用打勾或旗帜 `🏁 COMPLETED` 及 `✔️`。

### 4. 专项智能判重 (Deduplication Logic)
在代码实装时，如果你通过后端获取的 Session 数据中 `name` 和 `dir` (目录名) 是**完全一致**的字符串（例如：名字叫 t3code，目录也叫 t3code）：
- **UI 必须触发隐式去重**：直接在界面渲染中去掉元数据那一行的 `<i>(Folder: xxx)</i>` 渲染，避免重复的视觉污染。

---

## 示例最终渲染效果 (Mockup Template)
请下家 Agent 在重构渲染函数（如 `appendInteractionHubHint` 等生成函数）时，目标达成组装出类似下方的 HTML Text：

```html
🎯 <b>Active Hub</b> [目录：1/1]
━━━━━━━━━━━━━━━━━━

🟢 <b>SESSION #4: telegram-codex-bridge</b>
<i>(Folder: telegram-codex-bridge-dev)</i>
<b>[Runtime Preview]</b>
<blockquote expandable>"先把仓库地图立住：我会读领域路由和少量关键清单文件，确认哪些文档是“当前事实”，哪些只是计划或历史。
此外，有个关键点在确认：用户动作不是直接映射到 provider。目前已读取完核心文档并且正在生成最终的分析结果！请耐心等待..."</blockquote>

━━━━━━━━━━━━━━━━━━

🟡 <b>SESSION #2: t3code</b>
<b>[Runtime Preview]</b>
<blockquote expandable>"有个关键点我在确认：用户动作不是直接映射，我正在尝试复现并修复上一个步骤中遗留的环境变量读取 BUG..."</blockquote>

━━━━━━━━━━━━━━━━━━

🏁 <b>COMPLETED</b>
✔️ <b>1.</b> t3code
✔️ <b>3.</b> sub2api

💡 <i>/status | /inspect | /interrupt</i>
```
