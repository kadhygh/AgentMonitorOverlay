# Focus Panel / Card Framework 交接

后续状态：人工 Task groups 版本已在独立分支实现，替代本记录中的固定分类界面。继续开发请先读 [当前人工分组交接](2026-09-11-focus-manual-groups.md)；下文保留 `90808f8` 基线的实现和验证记录。

日期：2026-09-11。来源分支：`codex/focus-panel`。开发方式：独立 worktree，基于 `717c985`；本记录随实现提交并合回本地主线 `master`。提交号以 `git log` 为准。

## 用户已确认的方向

- 当前功能入口叫 **Focus Panel**，在 Open Canvas 旁用开关显示/隐藏独立悬浮面板。
- 用户继续与真实 CLI session 充分讨论方案、让其推进、亲自完整审核。系统保存注意力与处理进度；不做主控预审、强制精简审核包、自动派发或内嵌聊天平台。
- “不同框架”指围绕 Card 的功能框架，不是 CLI provider。Session 是最小运行单元；Card 是可组合的工作对象，未来可以包装多个 Session/其他 Card。
- 组件可以通过接口修改核心及其他组件的数据。Session 常规资料/执行状态，与 GUI/TUI 对话承载/绑定生命周期需要分组。
- 本轮允许不做旧数据兼容，因此采用新的 cards.json；没有旧 Focus 数据迁移器，也没有删除旧数据。

## 已完成

1. **Focus Panel**：主窗口开关、独立悬浮窗口、开关/关闭同步、隐藏暂停查询、主题；待处理/处理中/稍后/未来/已处理分组、搜索、备注、明确处理动作和返回 CLI/App。
2. **通用 CardStore**：独立 UUID Card、核心字段、组件数组、默认 Session→Card 索引、持久处理状态与事件去重、串行原子写入、失败退避与操作重放。
3. **内置组件**：`amo.session`、`amo.conversation`、`amo.processing`、`amo.notes`。有显式 schema/注册表/依赖校验。未知类型及版本保留数据，不执行未知能力。
4. **数据接口**：GET/POST `/api/cards`、GET `/api/cards/:cardId`、POST `/api/cards/:cardId/commands`。支持核心标题、归档/恢复、组件增删、备注与处理状态；批次最终依赖校验，任一步无效则不写入。
5. **独立工作卡**：Focus Panel 的 New card 可创建完全不关联 Session 的计划/想法卡。
6. **会话/对话拆分**：常规会话组提供身份、工程、运行状态；对话承载组提供 CLI/TUI、App/GUI、绑定与可用性。移除对话组件不会停止 Session。
7. **原生动作校验**：请求携带 Card 与组件 ID，主窗口重新读取当前关联/Session 后才调用已有操作。GUI 绑定不能误走 CLI Resume；打开会话不确认人工处理。

## 关键文件

| 文件 | 职责 |
|---|---|
| `broker/lib/card-store.js` | 通用持久存储、观察、组件命令、Focus 投影 |
| `broker/lib/card-components/schema.js` / `registry.js` | 组件与命令数据校验、依赖/数量规则 |
| `broker/lib/card-components/session-runtime.js` | 常规 Session 与 GUI/TUI 两组纯投影 |
| `broker/routes/cards.js` / `focus-panel.js` | 通用 Card 接口与 Focus 视图门面 |
| `broker/lib/session-collection.js` | 窄范围变化观察接口；现有 SessionStore 仍负责运行数据 |
| `overlay/src/windows/FocusPanelApp.tsx` | Focus UI |
| `overlay/src/focus/` / `overlay/src/api/cardClient.ts` | UI 模型、查询、操作、独立卡创建 |
| `overlay/src/hooks/useFocusPanelWindow.ts` | 显示/隐藏开关 |
| `overlay/src/hooks/useFocusPanelCommands.ts` / `overlay/src/runtime/focusCommandRouter.ts` | 主窗口原生操作委托与当前组件校验 |
| `scripts/performance/focus-panel-smoke.cjs` | 隔离真实 UI + Broker 集成测试，原生端口模拟 |

## 数据与边界

- 持久文件：会话数据目录旁的 `cards.json`；测试可设 `AGENT_MONITOR_CARDS_DATA_FILE`。
- Card 核心 schema 为 1；Focus 查询视图 schema 为 2。旧 schema-1 Focus 响应明确报不支持。
- 当前一个 Card 可有多个 Session 组件，但只有一个 processing 源、一个 notes；同一 Session 组件最多一个 conversation。多源一起确认/任务聚合未实现。
- Card 归档、Session 归档、删除视图节点、解除组件引用是不同动作。人工确认绑定观察到的源版本；换源必须显式重置旧游标。
- Card 标题经接口修改后不被 Session Hook 覆盖。
- 现有 Canvas 尚未迁入 CardStore；不要误认为 Canvas 节点已经全部引用 cardId。
- 存储串行保证限于单 Broker 进程；未知来源缺少稳定 turn/artifact ID 时依赖时间去重。
- 原生返回结果标明“已委托”，不冒充聚焦或恢复已经成功。

## 已有验证

- Broker 全套：**208 通过，0 失败**。
- 前端运行时全套：**103 通过，0 失败**。
- `npm run build`：通过，包含模型目录生成物检查。
- `cargo check --offline`：通过。
- 隔离浏览器测试：通过；真实 Focus UI、真实临时 Broker，原生接口模拟；覆盖真正 Broker 重启、回复去重、人工状态、失响应重放、备注冲突、独立卡、组件接口、无效批次回滚、对话组件移除及 Card 归档/恢复。
- 测试截图的原运行目录为 worktree 内 `tmp/focus-smoke-DDM94p`，属于忽略的本地验证产物，**没有随 Git 提交**；可重跑脚本生成。

可用命令（在相应目录执行）：

```powershell
# 仓库根目录
node --test broker/lib/*.test.js
# overlay 目录
npm run test:runtime
npm run build
# overlay/src-tauri 目录
cargo check --offline
# 仓库根目录；若无法解析 playwright，设置 AMO_PLAYWRIGHT_MODULE 为已有模块路径
node scripts/performance/focus-panel-smoke.cjs
```

这些测试不等于真实 Windows 窗口层级、CLI/App 聚焦和恢复验证。源代码提交/合并没有重启或部署正在运行的 AMO。

## 下一轮建议

先在真实 Windows 环境验证 Focus Panel 的日常 loop：开关与关闭同步、窗口位置/层级、点击返回正确 CLI、执行中/离线/权限等待、重复回复不反复提醒、处理中和未来分组保持、重启后的状态恢复。发现问题后优先修复这条流程。

之后再根据用户反馈改善面板交互；Card 多源聚合、Canvas 接入、Area 和秘书能力继续按实际需求分轮推进。本交接不授权自动扩展这些后续范围。

## 主目录未提交内容

合并前 `G:/PROJECT/AgentMonitorOverlay` 主目录已有以下修改，属于其他工作，本轮提交不包含它们：

- `docs/canvas-area-task-orchestration-plan-2026-09-07.md`（已修改）
- `docs/managed-side-fork-plan.md`（已修改）
- `overlay/src-tauri/Cargo.toml`（已修改）
- `docs/obsidian-managed-fork-investigation-2026-09-08.md`（未跟踪）

继续前先 `git status`，不要 reset、清理或混入下一轮提交。若在新的 worktree 开发，默认只包含主线提交，不会自动包含以上主目录未提交内容。

相关当前规范：[Card 框架](../card-framework-design-2026-09-11.md)、[Focus 使用](../focus-panel.md)、[组件整理执行记录](../tasks/card-components-refactor-2026-09-11.md)。
