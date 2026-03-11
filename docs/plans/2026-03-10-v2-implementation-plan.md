# Telegram Codex Bridge V2 实施计划

状态：2A Ready for execution；2B/2C 需在开工前补齐阶段实施细则
日期：2026-03-10
适用范围：V2 全量实施编排（以 2A 先行）
优先级：结构化活动流 > 会话管理增强 > 平台与稳定性补齐

相关文档：
- 主依据：`/home/ubuntu/Repo/docs/plans/telegram-codex-bridge-plan-draft.md`
- V2 PRD：`docs/future/v2-prd.md`
- V2 工程评估：`docs/telegram-codex-bridge-v2-engineering-eval.md`
- 2A 详细设计：`docs/plans/2026-03-10-v2-2a-detailed-design.md`

---

## 1. 计划目标

这份计划不是概念性 roadmap，而是 **以 2A 可直接开工、2B/2C 继续细化后开工** 的实施编排。

目标是：
1. 先把 **2A 结构化活动流** 做成可上线的第一阶段交付；
2. 再进入 **2B 会话管理增强**；
3. 最后完成 **2C 平台与稳定性补齐**；
4. 每一阶段都要求：有明确代码落点、测试项、验收口径、切线（cut line）和回滚边界。

---

## 2. 总体策略

### 2.1 实施顺序

固定顺序：
- **2A：结构化活动流**
- **2B：会话管理增强**
- **2C：平台与稳定性补齐**

### 2.2 执行原则

- 不等待 2B/2C 细节全部写完才开始 2A。
- 2A 先落地，2B/2C 以“边界清晰、可继续细化”的方式排队推进。
- 如果出现范围/时间压力，优先保住 2A；不得为了 2B/2C 牺牲 2A 主交付。

### 2.3 V2 cut line

如果 V2 无法一次完整交付，则按以下切线执行：

**必须保住：**
- 原生事件消费
- 三层可见性映射
- normalized status model
- Telegram 默认层高价值事件消息（编辑更新）
- `/inspect`
- 本地 debug journal

**可以后移到后续阶段：**
- session archive/unarchive 的完整 UX
- macOS `launchd` 的完整安装体验
- 更强的 preflight / doctor 输出
- 更完整的恢复/自愈策略

---

## 3. 当前已完成前置物

目前已经具备的前置资产：
- V2 PRD 已完成
- 工程评估已完成（结论：`Feasible with constraints`）
- 2A 详细设计已完成（结论：`ready to build`）
- 当前 v1 基座已存在：
  - app-server 子进程与协议接入
  - SQLite 状态
  - readiness / restart / recovery 基础能力
  - Telegram poller / command / UI 基础结构

因此，当前可以直接进入 **2A** 实现，不再需要补产品前置文档。
但 **2B / 2C 还不能按本文件当前粒度直接整体开工**，需要在对应阶段启动前补齐阶段实施细则。

---

## 4. 2A 实施计划：结构化活动流

## 4.1 2A 目标

交付以下能力：
- 原生 app-server 通知消费
- 三层可见性模型（Default / Inspect / Debug）
- normalized status model
- Telegram 默认层的**低频高价值动作/结果事件**展示
- `/inspect` 按需展开
- 本地 JSONL debug journal

### 4.1.1 2A 产品决策修正（当前 authoritative）

如与本文件较早版本的“状态卡 / 运行态提示”表述冲突，以本节为准：

- 2A 默认层不再以 `running / starting / 耗时 / other` 这类状态为核心输出。
- 2A 默认层应以 **动作 + 结果** 为核心输出，例如：
  - `Ran cmd: <command>`
  - `Found: <key finding>`
  - `Changed: <key change>`
  - `Blocked: <reason>`
  - `Done: <result>`
- Inspect 层应承载更多真正有用的执行中细节。
- reasoning 不进入用户可见层；commentary 只允许 best-effort 使用。

## 4.2 2A 非目标

本阶段不做：
- session archive/unarchive
- session delete
- macOS `launchd`
- SQLite schema 扩展
- Telegram 按钮式 Inspect
- 在 Telegram 中显示 raw debug 流

## 4.3 2A 代码落点

### 新增模块
- `src/activity/types.ts`
- `src/activity/tracker.ts`
- `src/activity/debug-journal.ts`
- `src/codex/notification-classifier.ts`

### 修改模块
- `src/codex/app-server.ts`
- `src/service.ts`
- `src/telegram/api.ts`
- `src/telegram/ui.ts`
- `src/telegram/commands.ts`
- `src/paths.ts`
- `src/service.test.ts`

## 4.4 2A 分步实施

### Step 2A-1：事件分类与状态归约骨架

目标：先把“事件 -> 内部统一事件 -> normalized status”链路打通。

任务：
- 在 `src/codex/notification-classifier.ts` 建立原生通知分类器
- 在 `src/activity/types.ts` 定义：
  - turn status
  - active item type
  - inspect snapshot
  - debug journal record
- 在 `src/activity/tracker.ts` 实现：
  - turn lifecycle reducer
  - active item reducer
  - latest progress reducer
  - inspect timeline buffer
- 支持的最小事件集：
  - `turn/started`
  - `turn/completed`
  - `thread/status/changed`
  - `item/started`
  - `item/completed`
  - `item/mcpToolCall/progress`
  - `error`
  - legacy 兼容：`codex/event/task_complete` / `codex/event/turn_aborted`

完成标准：
- reducer 单测通过
- 能从样例通知流生成稳定状态对象
- 未知事件不会导致崩溃，而是安全落入 debug/other

测试：
- 新增 tracker/reducer 单测
- 覆盖 turn start -> item start -> progress -> complete
- 覆盖 failure / interrupted / unknown item type

### Step 2A-2：Debug journal 与运行时路径

目标：把 raw 数据保存下来，但不污染聊天界面。

任务：
- 在 `src/paths.ts` 增加 runtime debug 目录
- 在 `src/activity/debug-journal.ts` 实现 JSONL 写入
- 做大小/轮转边界控制（先简单可用，避免无限增长）
- 在 `src/service.ts` 接入：收到通知先写 journal，再做 reducer

完成标准：
- 每个 turn 能生成对应 debug journal
- 不需要 SQLite 持久化
- 写入失败不会拖垮主流程，只记录错误

测试：
- 路径生成测试
- JSONL record 格式测试
- 写入失败容错测试

### Step 2A-3：Telegram 默认层高价值事件

目标：让长任务在默认聊天里显示**有用信息**，而不是状态刷屏。

任务：
- 在 `src/telegram/api.ts` 维持单条 bridge-owned 默认消息的编辑能力
- `sendMessage` 返回足够数据以保存 message id
- 在 `src/telegram/ui.ts` 实现 Layer A 的高价值事件渲染
- 在 `src/service.ts` 维护 turn-scoped default-message state，确保同一 turn 只维护一条默认消息
- 只把以下内容推入默认层：
  - `Ran cmd`
  - `Found`
  - `Changed`
  - `Blocked`
  - `Done`
- 对 commentary 只做 best-effort 使用；对 reasoning 一律不暴露
- 节流规则按“真有新信息才更新”落地：
  - 新的高价值事件：立即更新
  - 纯状态/耗时/heartbeat：不更新
  - rate-limit：进入冷却，不允许 fallback 成 send flood

完成标准：
- 同一 turn 默认只维护一条 bridge-owned 消息
- 默认层不再刷 `starting / running / 耗时 / other`
- 默认层能稳定显示动作 + 结果
- turn 完成/失败/中断时正常收口

测试：
- `service.test.ts` 覆盖单 turn 单消息一致性
- 覆盖 `other` / duration-only 不驱动默认层更新
- 覆盖 Telegram rate-limit 不会导致 send flood
- 覆盖高价值事件触发更新

### Step 2A-4：`/inspect` 扩展视图

目标：把 Layer B 做成“真正有用的执行细节”承载面。

任务：
- 在 `src/telegram/commands.ts` 注册 `/inspect`
- 在 `src/telegram/ui.ts` 实现 inspect renderer
- inspect 输出优先包含：
  - recent commands
  - command/result summaries
  - fileChange summaries
  - MCP progress/tool summaries
  - webSearch summaries
  - plan snapshot
  - optional best-effort commentary snippets
- inspect 不返回 raw delta / raw reasoning / raw protocol 帧
- inspect 只做快照，不做 push 更新

完成标准：
- 用户发送 `/inspect` 能拿到结构化且有信息量的详情
- Inspect 不只是重复默认层状态
- 没有活动数据时给出诚实 fallback

测试：
- inspect 有数据/无数据
- inspect 在 turn running/completed/failed 下的表现
- inspect 不泄露 raw reasoning / raw delta

### Step 2A-5：集成验证与文档回填

本步骤要求明确更新以下 canonical docs：
- `docs/product/` 下的当前用户可见行为说明
- `docs/operations/` 下的 Debug 获取/排障说明
- `/inspect` 的命令与使用方式说明（落在合适的 product/operations 文档）


目标：确认 2A 真正 ready to ship。

任务：
- 跑 `npm run check`
- 跑 `npm test`
- 至少做一轮手动回归：
  - 短任务
  - 长任务
  - MCP progress
  - 命令执行型任务
  - edit fallback
  - `/inspect`
- 更新 docs：
  - 当前行为说明
  - Debug 获取说明
  - `/inspect` 使用说明

完成标准：
- 自动测试通过
- 手动回归通过
- 文档更新完成

## 4.5 2A 验收口径

2A 完成后必须满足：
- 长任务默认不再是纯黑盒
- 默认层给出的信息是“动作 + 结果”，而不是状态刷屏
- 默认层同一 turn 只维护一条消息
- `/inspect` 能看到更细且真正有用的结构化信息
- debug 数据存在本地，不污染 Telegram 主流程
- v1 最终答案路径不被破坏

## 4.6 2A 回滚边界

如出现问题，可按以下顺序降级：
1. 关闭 `/inspect`
2. 关闭默认消息编辑，仅保留初始默认消息
3. 保留 final-answer-only 主流程
4. 保留 debug journal 但不启用用户态展示

---

## 5. 2B 实施计划：会话管理增强

## 5.1 2B 目标

交付以下能力：
- session list 更清晰
- session state 更清晰
- current active session 更明确
- same-host continuity 语义对齐
- archive/unarchive

## 5.2 2B 非目标

- cross-host / cross-machine continuity
- hard delete
- 复杂 pin/favorite 重构
- 高级会话分类系统

## 5.3 2B 代码方向

重点模块预计包括：
- `src/state/store.ts`
- `src/service.ts`
- `src/telegram/commands.ts`
- `src/telegram/ui.ts`
- 可能新增 session presentation / archive helpers

## 5.4 2B 分步实施

### Step 2B-1：session presentation model
- 定义 session list 对外字段：
  - name
  - project
  - state
  - last activity / last used
  - active marker
  - archived flag
- 明确 archived 与 runtime status 分离

### Step 2B-2：archive/unarchive

**开工前必须先补齐 archive 一致性契约**，至少定义：
- 本地 archived flag 与远端 `thread archive/unarchive` 谁是准绳
- 本地成功 / 远端失败时如何回滚
- 远端成功 / 本地失败时如何修复
- RPC 返回与后续 notification 不一致时如何收敛

在此契约明确前，2B 不进入实现。

契约明确后再实施：
- 本地状态支持 archived flag / metadata
- 如 `threadId` 存在，则对接 remote thread archive/unarchive
- 默认列表隐藏 archived，会有显式查看方式

### Step 2B-3：session list / current session UX
- 优化 `/sessions`
- 增加 current active marker
- 明确失败态和 failure reason

### Step 2B-4：same-host continuity 对齐
- 对齐 rebind 后的用户可见行为
- 明确 continuity 成功/失败时的文案和状态呈现
- 不承诺恢复 in-flight turn

## 5.5 2B 开工前门槛

2B 进入实现前，必须先补齐一份阶段实施细则，至少包括：
- archive 一致性契约
- 本地/远端状态机
- 失败回滚策略
- 会话列表具体字段与排序规则
- same-host continuity 的用户可见状态规则

## 5.6 2B 验收口径

2B 完成后必须满足：
- session list 比 v1 明显更可理解
- archive/unarchive 可用
- active session 明显可见
- same-host continuity 边界诚实清楚
- 不暗示 cross-machine portability

---

## 6. 2C 实施计划：平台与稳定性补齐

## 6.1 2C 目标

交付以下能力：
- macOS `launchd` 持久化
- readiness / preflight 提示增强
- restart / reconnect 行为更清楚
- corruption fallback 更明确
- silent failure 减少

## 6.2 2C 非目标

- 跨平台高级守护进程统一框架重写
- 跨机迁移
- 完整自愈编排平台

## 6.3 2C 代码方向

重点模块预计包括：
- `src/install.ts`
- `src/readiness.ts`
- `src/service.ts`
- `src/state/store.ts`
- `src/cli.ts`
- 与平台 service manager 相关的新抽象模块

## 6.4 2C 分步实施

### Step 2C-1：service manager abstraction
- 抽出 systemd / launchd 适配层
- 当前 Linux 能力不回退
- 补 macOS `launchd` install/run/uninstall

### Step 2C-2：preflight/readiness
- 提前检查：
  - codex 是否可用
  - 认证状态
  - token / bot config
  - workdir / path
  - node/runtime 前置
- 输出更明确的 operator 指引

### Step 2C-3：restart/reconnect
- 定义 bridge restart / app-server lost / reconnecting 的状态语义
- 统一恢复后的用户可见行为

### Step 2C-4：corruption fallback
- 明确 state corruption 后的 reset / backup / user-visible 提示
- 补测试

## 6.5 2C 开工前门槛

2C 进入实现前，必须先补齐一份阶段实施细则，至少包括：
- systemd / launchd 抽象边界
- install/run/uninstall 的 operator 流程
- readiness/preflight 检查矩阵
- restart/recovery/corruption 的状态机与用户可见行为

## 6.6 2C 验收口径

2C 完成后必须满足：
- macOS 不再只是“理论可用”
- readiness 失败时能更快定位
- restart/recovery 行为更清晰
- corruption fallback 可测试且不静默坏掉

---

## 7. 实施节奏与 checkpoint

## 7.1 推荐 checkpoint

### Checkpoint 1：2A 核心骨架
产物：
- `activity/` 模块骨架
- notification classifier
- normalized status reducer 测试

通过条件：
- `npm run check`
- 新增单测通过

### Checkpoint 2：2A 默认层高价值事件
产物：
- Telegram `editMessageText`
- one-message default lifecycle
- high-value event rendering
- throttle / cooldown / no-flood 行为

通过条件：
- 手动验证长任务默认层显示的是有用信息
- `service.test.ts` 新覆盖通过

### Checkpoint 3：2A Inspect + debug
产物：
- `/inspect`
- JSONL debug journal
- 2A 文档回填
- Inspect 层的 recent command/result/tool/file-change 展示

通过条件：
- `npm test`
- 手动回归通过
- 2A 可宣布实现完成

### Checkpoint 4：2B 启动
产物：
- session presentation model
- archive state 方案

### Checkpoint 5：2C 启动
产物：
- service manager abstraction 草稿
- launchd 实施切面
- readiness 增强项清单

## 7.2 推荐推进方式

- 先按 checkpoint 1~3 完成 2A
- 2A 合并后再进入 2B
- 2B 稳定后进入 2C
- 不建议三条主线并行大展开，避免上下文过度分散

---

## 8. 测试计划

## 8.1 自动测试

每个阶段至少执行：
- `npm run check`
- `npm test`

## 8.2 2A 新增测试重点

- event classifier
- tracker reducer
- duplicate suppression
- throttle / cooldown
- one-message default lifecycle
- high-value event rendering
- inspect snapshot rendering
- no raw reasoning leakage

## 8.3 2B 新增测试重点

- archive/unarchive state transition
- session list rendering
- same-host continuity edge cases

## 8.4 2C 新增测试重点

- launchd generation/install logic
- readiness/preflight matrix
- corruption fallback path
- reconnect/restart state handling

---

## 9. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 原生事件消费比预期复杂 | 2A 延迟 | 先保最小事件集，不一次吞全量事件 |
| Telegram edit 行为不稳 | 默认层 UX 受损 | 引入 cooldown；保证 one-message invariant；禁止 fallback 成 send flood |
| Debug journal 膨胀 | 本地运行时噪音 | JSONL + rotation/size bound |
| 2B 想做太多 | 延迟主线 | 保持 archive-first，delete 不进 V2 |
| 2C 过度扩张 | V2 拉长 | 先补 launchd + readiness + recovery 主线 |

---

## 10. 角色分工建议

### 开发
负责：
- 按 checkpoint 实现
- 填写/更新工程评估回执中的进度状态
- 每个 checkpoint 给出产物路径、测试结果、剩余 blocker

### PM / 管理
负责：
- 审查 cut line 是否被遵守
- 防止 2B/2C 抢走 2A 优先级
- 对 archive/delete、launchd 是否纳入本轮做最终边界把关

---

## 11. 开工判定

当前结论：**可以直接开工，但仅限 2A。**

开工前不再需要补的内容：
- 不需要再补新的 PM 文档
- 不需要再等 2B/2C 细化完
- 不需要再做一轮高层方案讨论

开工前唯一要对齐的是：
- 本轮文档引用统一使用当前仓库真实路径
- 产物默认继续写入 `docs/` 现有信息架构下

补充说明：
- **2A：可直接开工**
- **2B：需先补 archive 一致性契约与阶段实施细则**
- **2C：需先补平台/稳定性阶段实施细则**

---

## 12. 一句话执行指令

**现在开始按 Checkpoint 1 → 2 → 3 实现 2A；2A 合并后，先补 2B 阶段实施细则再进入 2B；2B 稳定后，先补 2C 阶段实施细则再进入 2C。**
