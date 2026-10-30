# 提示词模板（2026-10-31）

用户常开同样的任务，要一个存好提示词、在输入框里一选就粘进去的功能；模板可以让 AI 通过 AMO 的 MCP 按要求加。同时**删掉扩展包**（`.amo/packs`）：模板比它好用，扩展包一直没有真实的包。以后可能做类似 DSH 的插件架构，到时另起方案。

分支 `studio/prompt-templates`，worktree `G:\PROJECT\AgentMonitorOverlay-templates`（主工作区有别的会话在干活）。

## 用户定的（都按建议）

1. **范围**：全局和「只在某个项目里出现」都支持，默认全局。
2. **变量**：第一版不做，纯文本。
3. **AI 写模板**：新增、修改直接生效，删除要人批准（MCP 工具不自动通过）；列表里标出 AI 写的。

## 做法

- **数据**：Host 的 kv（`prompt-templates`，一个 JSON 数组），在数据目录里，不进项目。每条：`id`、`title`、`body`、`workspaceId`（null = 全局）、`by`（最后一次是人还是 AI 写的）、`createdAt`、`updatedAt`。上限：200 条，标题 80 字，正文 20000 字。变化时发 `prompt-templates.changed`。
- **Host 功能模块** `features/prompttemplates/`：service、routes（`GET/POST /api/prompt-templates`、`PATCH/DELETE /api/prompt-templates/:id`；GET 带 `?workspace=` 时只给全局的和这个项目的）、mcp：
  - `prompt_template_list`：只读，自动通过；
  - `prompt_template_save`：新建或修改（带 id），自动通过；
  - `prompt_template_delete`：要人批准。
- **界面**：@ 列表「AMO 扩展功能」里加「提示词模板…」，会话输入框、新建任务页、快速开始条都有。选中后弹窗：上面搜索，左边列表（全局 / 项目名、AI 写的），右边预览；回车或「粘进输入框」把正文放到打 @ 的位置，不自动发送。新建、编辑、删除也在这个弹窗里。

## 删除扩展包

Host 的 `features/packs`、`packs/`（加载器、预设草稿）、读模型的 `packList`/`packDoc`、调度简报里的预设、新建任务带的流程模板（`template` 参数）；「一键忽略 .amo/」（只为扩展包存在）；protocol 的 `packs.ts`、`TaskTemplateChoice`、可关闭功能里的 `packs`；界面的扩展包页、任务页的预设和文档面板、会话树的「按扩展包预设」、新建任务的流程模板；e2e `packs`、`pack-acceptance`；`examples/packs`、`scripts/smoke-stage6.mjs`；`design/pack-format.md` 挪进 `docs/archive/`。

留着：任务清单（`checklist_items`、`checklist_check`），老任务上已有的清单照样显示和勾选；设置里已关掉的 `packs` 读的时候忽略。

## 验证

- 单测：service（增删改、范围过滤、上限、事件）、MCP（三个工具、删除不自动通过）、mentions（扩展功能里有这一项）。
- e2e：@ → 提示词模板… → 新建一条 → 选中粘进输入框；新建任务页同样能用。截图放 `screenshots/studio/`。
- `npm run verify`。
