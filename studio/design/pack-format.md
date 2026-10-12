# 扩展包格式（schemaVersion 1）

扩展包放在工作区里：`<工作区>/.amo/packs/<name>/pack.json`，一个目录一个扩展包，随工程进版本库。校验代码：`packages/protocol/src/packs.ts`。

## 示例

```json
{
  "schemaVersion": 1,
  "name": "demo",
  "title": "示例扩展包",
  "description": "这个扩展包是做什么的",
  "docs": [
    { "id": "style", "title": "代码规范", "path": "docs/style.md", "summary": "命名与目录约定" }
  ],
  "templates": [
    { "id": "feature", "title": "新功能", "titlePrefix": "[功能]", "steps": ["读规范", "实现", "补测试", "自查"] }
  ],
  "presets": [
    {
      "id": "impl",
      "title": "按规范实现",
      "profile": "codex-deepseek-flash",
      "prompt": "实现「{{task.title}}」。开始前先读 {{pack.dir}}/docs/style.md。",
      "contextFiles": ["src/main.ts"]
    }
  ],
  "tools": [
    { "name": "weapon_lookup", "description": "预留：查询武器配置表" }
  ]
}
```

## 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `schemaVersion` | 是 | 目前是 `1` |
| `name` | 是 | 小写字母、数字、`-`、`_`，最长 40；建议与目录名相同 |
| `title` | 是 | 显示名，最长 100 |
| `description` | 否 | 最长 2000 |
| `docs[]` | 否 | 规范文档：`id`、`title`、`path`（相对扩展包目录）、`summary`。工作台里可以查看，agent 通过 MCP 读取 |
| `templates[]` | 否 | 流程模板：`id`、`title`、`titlePrefix`（加在任务标题前）、`description`、`steps`（任务清单，至少一步） |
| `presets[]` | 否 | 启动预设：`id`、`title`、`profile`（模型配置 id，不存在时用默认模型）、`prompt`（第一条消息）、`contextFiles`（相对工作区，列在提示词里让 agent 自己读） |
| `tools[]` | 否 | 专用工具：**只是预留**，列出来但不会运行 |

提示词里可用的变量：`{{task.title}}`（任务标题）、`{{workspace.path}}`（工作区的绝对路径）、`{{pack.dir}}`（扩展包目录，相对工作区，例如 `.amo/packs/demo`；会话就在工作区里运行）。写了其他变量会报错。

## 限制（按不可信内容处理）

- 扩展包可能是别人提交到工程里的，所以 Studio 只读取，不运行其中任何代码，也不启动扩展包里的 MCP 服务。
- 路径只能是相对路径：不能是绝对路径，不能有盘符或 `:`，不能有 `..`；读取时还会检查符号链接有没有指到外面。
- 数量与长度：每类最多 50 项；清单最多 50 步，每步 500 字；提示词最多 8000 字；上下文文件最多 20 个；单个文档最大 512 KB。
- 启动预设只会预填新会话表单，由人确认后才发给模型。
- 未知的顶层字段给出警告并忽略；其他错误会让这个扩展包显示为"有错误"，不影响同一工作区的其他扩展包。
