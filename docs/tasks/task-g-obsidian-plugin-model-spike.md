# Task: Obsidian Plugin Model Spike

Owner: worker-obsidian-plugin
Stage: Future parallel spike from Phase 6.x planning
Status: todo

## Goal

- 为 Obsidian 侧定义 note / canvas / annotation 的内部模型和插件职责边界。
- 明确哪些能力必须由 Obsidian 插件负责，而不是由 AMO 本体负责。
- 为后续插件实现准备稳定的命令、数据结构和用户动作模型。

## Allowed Scope

- 更新 `docs/` 下与 Obsidian 插件模型相关的设计文档。
- 新增面向插件侧的结构草案，例如：
  - note frontmatter / metadata
  - annotation 数据结构
  - canvas attachment contract
  - plugin command list
- 如确有必要，可新增轻量原型目录或示例文件，例如：
  - `examples/obsidian/`
  - `prototypes/obsidian-plugin/`
- 可调研 Obsidian plugin API、canvas file shape、note annotation 可行实现路径，并记录风险。

## Forbidden Scope

- 不要求完成可发布的 Obsidian 插件。
- 不接入 AMO 主线 UI。
- 不实现窗口路由。
- 不实现 CLI 回传。
- 不要求真实改动用户 vault 内容，除非主管 agent 明确要求做 disposable 验证。
- 不执行 git commit / branch / push。

## Required Context

- `PROJECT_PLAN.md`
- `DEVELOPMENT.md`
- `docs/supervisor-status.md`
- `docs/tasks/task-f-obsidian-external-note-jump-spike.md`

## Acceptance Criteria

- 明确 Obsidian 插件负责的边界：
  - vault-native note/canvas 变更
  - annotation capture
  - annotation summary generation
- 给出推荐的 note / annotation / canvas 数据模型草案。
- 明确第一版插件最小命令集合，例如：
  - create/open linked note
  - attach note to target canvas
  - add annotation
  - summarize annotations
- 明确哪些字段应由 AMO 提供，哪些字段应由 Obsidian 侧维护。
- 明确后续与 sync-back bridge 的交接点。

## Verification

- 如果做原型，只允许在隔离样例或 disposable vault 思路下验证。
- 必须区分：
  - 已本机验证的 Obsidian 行为
  - 仅依据文档推断的插件设计
- 如不能做本机验证，要给出精确的后续验证步骤和风险点。

## Report Back

Worker 完成后汇报：

1. 做了什么。
2. 改了哪些文件。
3. 推荐的插件职责边界是什么。
4. 推荐的数据模型和命令集合是什么。
5. 实际验证了什么。
6. 哪些能力适合后续先做 prototype。
7. 是否需要主管 agent 或用户决策。
