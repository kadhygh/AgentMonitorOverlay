# Obsidian Annotation Plugin Development Handoff

更新时间：2026-05-12

本文档用于把当前 Obsidian 批注插件项目交给其他 Codex session 或其他项目继续开发。目标是让接手者先理解现状，再按现有结构小步修改。

## 1. 项目目标

当前插件名为 `Markdown Annotation Tools`，插件 ID 为 `md-anno-tools`。

核心目标：

- 在 Obsidian 阅读模式中，把 Markdown 原文里的 `[!anno]...[/anno]` 渲染成特殊批注样式。
- 提供按钮和命令，一键提取当前笔记中的批注正文并复制到剪切板。
- 在编辑模式中支持选中文本后右键添加批注。
- 保持 Markdown 原文件中批注以纯文本标签存在，避免引入额外数据库或 sidecar 文件。

当前语法：

```md
[!anno]这是批注内容[/anno]
```

多行批注也支持：

```md
[!anno]
这是第一行。

这是第二段。
[/anno]
```

## 2. 当前工作目录与测试 vault

插件项目目录：

```text
D:\Projects\CommonProject\obsidianplugintest
```

测试 vault：

```text
D:\Projects\CommonProject\obsidianplugintestvault
```

测试 vault 中插件安装目录：

```text
D:\Projects\CommonProject\obsidianplugintestvault\.obsidian\plugins\md-anno-tools
```

测试笔记：

```text
D:\Projects\CommonProject\obsidianplugintestvault\TestNote.md
```

## 3. 关键文件

```text
src/main.ts        插件全部 TypeScript 逻辑
styles.css         批注渲染样式和追加批注 modal 样式
manifest.json      Obsidian 插件 manifest
package.json       npm scripts 和依赖
main.js            构建产物，Obsidian 实际加载它
README.md          用户级使用说明
```

当前实现没有 settings tab，也没有额外状态文件。所有用户数据都保存在 Markdown 原文件里。

## 4. 当前功能清单

### 4.1 阅读模式批注渲染

入口：

```ts
this.registerMarkdownPostProcessor((el: HTMLElement) => {
  this.renderAnnotations(el);
});
```

核心行为：

- 在 Obsidian 阅读模式渲染后的 DOM 上运行 post processor。
- 使用 `TreeWalker` 找文本节点。
- 只处理同时包含 `[!anno]` 和 `[/anno]` 的文本节点。
- 跳过这些标签内的内容：

```ts
['A', 'BUTTON', 'CODE', 'INPUT', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA']
```

跳过代码块的原因：代码块里的 `[!anno]...[/anno]` 应展示为代码，不应被插件替换成批注 UI。

当前限制：

- 只处理同一个 text node 内完整出现的 `[!anno]...[/anno]`。
- 如果 Obsidian Markdown 渲染器把开闭标签拆到不同 DOM 节点，当前 post processor 不会跨节点合并。
- 批注内容按纯文本显示，不做 Markdown 二次渲染。

### 4.2 复制当前笔记中的批注

入口包括：

- 左侧 Ribbon 图标：`clipboard-copy`
- 当前 Markdown view 右上角 action：`view.addAction('clipboard-copy', ...)`
- 命令面板：`复制当前笔记中的批注到剪切板`

核心流程：

1. 获取当前 active markdown file。
2. `this.app.vault.cachedRead(file)` 读取原始 Markdown。
3. 用正则提取批注：

```ts
const ANNO_REGEX = /\[!anno\]([\s\S]*?)\[\/anno\]/gi;
```

4. trim 批注正文。
5. 用空行连接多条批注。
6. 调用 `navigator.clipboard.writeText()` 写入剪切板。

当前限制：

- 空批注不会被复制。
- 复制结果只有批注正文，不包含序号、来源行号、文件名。
- 没有 fallback 到 deprecated `document.execCommand('copy')`，因为 lint 禁止且现代 Obsidian 环境应支持 Clipboard API。

### 4.3 编辑模式右键添加批注

入口：

```ts
this.app.workspace.on('editor-menu', (menu, editor) => {
  const selection = editor.getSelection();
  if (!selection || selection.trim().length === 0) {
    return;
  }

  menu.addItem((item) => {
    item
      .setTitle('为当前选中文本添加批注')
      .setIcon('message-square-plus')
      .onClick(() => {
        this.wrapSelectionWithAnnotation(editor);
      });
  });
});
```

行为：

- 只在编辑器中有非空选区时显示右键菜单项。
- 点击后把选中文本替换为：

```md
[!anno]选中文本[/anno]
```

当前限制：

- 这是编辑模式右键菜单，不是阅读模式选中文本右键。
- 当前设计是“把选中文本本身变成批注内容”，不是“给原文旁边追加一个评论”。如果后续要做真正的 anchored annotation，需要新设计原文和批注之间的绑定方式。

### 4.4 命令面板包裹选区

命令：

```text
用 [!anno]...[/anno] 包裹当前选中内容
```

行为：

- 有选区：包裹选区。
- 无选区：插入空标签 `[!anno][/anno]`，并把光标移到标签中间。

### 4.5 向当前笔记末尾追加批注

命令：

```text
向当前笔记末尾追加批注
```

行为：

- 弹出 `AnnotationInputModal`。
- 用户输入批注正文。
- 插件把批注追加到当前笔记末尾。

限制：

- 不允许批注正文包含 `[/anno]`，避免破坏标签配对。
- 追加位置固定为文件末尾。

## 5. 构建与验证

安装依赖：

```powershell
cd D:\Projects\CommonProject\obsidianplugintest
npm install
```

构建：

```powershell
npm run build
```

Lint：

```powershell
npm run lint
```

当前已验证过：

```text
npm run build 通过
npm run lint 通过
```

构建产物：

```text
main.js
manifest.json
styles.css
```

同步到测试 vault：

```powershell
$target = 'D:\Projects\CommonProject\obsidianplugintestvault\.obsidian\plugins\md-anno-tools'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item -LiteralPath '.\main.js','.\manifest.json','.\styles.css' -Destination $target -Force
```

Obsidian 中验证：

1. 打开测试 vault：`D:\Projects\CommonProject\obsidianplugintestvault`
2. 确认第三方插件已开启。
3. 启用 `Markdown Annotation Tools`。
4. 打开 `TestNote.md`。
5. 阅读模式检查批注渲染。
6. 编辑模式选中文本右键，检查“为当前选中文本添加批注”。
7. 点击复制批注按钮，检查剪切板内容。

如果插件文件更新后 Obsidian 没反应：

- 先关闭再启用插件。
- 或重启 vault。
- 或完全重启 Obsidian。

## 6. 当前样式结构

主要 CSS class：

```text
.anno-token
.anno-token-block
.anno-token-badge
.anno-token-content
.anno-modal
.anno-modal-input
.anno-modal-actions
```

设计意图：

- `.anno-token`：行内批注样式。
- `.anno-token-block`：当整段只有一个批注时，用块级展示。
- `.anno-token-badge`：左侧“批注”小标签。
- `.anno-token-content`：批注正文，保留换行。

注意：

- 当前样式使用 Obsidian 主题变量，例如 `var(--background-secondary)`、`var(--interactive-accent)`。
- 不要硬编码大面积颜色，避免在深色/浅色主题下出问题。

## 7. 数据格式和兼容性

当前只依赖 Markdown 原文中的标签：

```md
[!anno]...[/anno]
```

优点：

- 可移植。
- 不依赖插件数据库。
- 用户可以直接搜索原文。
- 插件卸载后不会丢数据。

缺点：

- 不支持嵌套批注。
- 不支持标签跨 DOM 节点渲染。
- 不支持批注元数据，例如作者、时间、颜色、resolved 状态。

如需扩展元数据，建议优先考虑仍然保持 Markdown 可读，例如：

```md
[!anno author="kadhy" color="yellow" created="2026-05-12"]内容[/anno]
```

但这会要求替换当前正则解析方案，不能继续只靠简单 regex。

## 8. 可能的下一阶段方向

### 8.1 阅读模式选中原文并添加批注

这是和当前右键能力不同的一类需求。当前右键能力只工作在编辑模式，因为 Obsidian 的 `editor-menu` 能直接拿到 `Editor` 和选区。

阅读模式要做，需要解决：

- 如何从 DOM selection 映射回 Markdown 源文本位置。
- 如果 selection 横跨多个 Markdown token，如何安全写回。
- 如果原文重复出现，如何确定写回位置。

建议不要直接从阅读 DOM 粗暴替换原文件。更稳的方向：

1. 阅读模式只收集选中文本。
2. 提示用户确认。
3. 尝试在源文件中定位唯一匹配文本。
4. 若唯一匹配，写回 `[!anno]选中文本[/anno]`。
5. 若多处匹配，提示用户切换编辑模式或提供选择 UI。

### 8.2 支持批注 Markdown 渲染

当前批注正文是纯文本。如果要让批注正文内部支持 `**粗体**`、链接、列表，可以考虑使用 `MarkdownRenderer.render()` 对批注正文做二次渲染。

风险：

- 二次渲染中如果再次触发本插件 post processor，可能造成递归或重复处理。
- 需要给每个渲染 child 正确绑定 lifecycle。
- 需要继续避免 code/pre 中误处理。

### 8.3 提取批注时增加结构

当前复制格式：

```text
批注 1

批注 2
```

可扩展为：

```md
# 批注摘录：文件名

1. 批注内容
2. 批注内容
```

或者 JSON：

```json
[
  {
    "file": "TestNote.md",
    "index": 1,
    "content": "..."
  }
]
```

如果后续做“批注导出到新 note”，建议新建单独命令，不要改变当前复制命令的简单行为。

## 9. 给其他 session 的建议启动提示

可以把下面这段直接喂给新的 Codex session：

```text
你接手 D:\Projects\CommonProject\obsidianplugintest 这个 Obsidian 插件项目。
请先阅读 docs/OBSIDIAN_ANNOTATION_PLUGIN_DEVELOPMENT.md、src/main.ts、styles.css、manifest.json。
当前插件支持 [!anno]...[/anno] 阅读模式渲染、复制当前笔记批注、编辑模式右键把选中文本包成批注。
请不要先大改架构；先说明你理解的当前实现和你计划修改的最小文件范围。
构建验证命令是 npm run build 和 npm run lint。
测试 vault 是 D:\Projects\CommonProject\obsidianplugintestvault，插件部署目录是 .obsidian\plugins\md-anno-tools。
```

## 10. 接手注意事项

- 当前项目目录不一定是 git 仓库，做改动前先确认 `git status` 是否可用。
- 不要把 `node_modules`、`main.js`、`.codex/cache/` 当作源文件提交。
- 修改插件逻辑后必须重新运行 `npm run build`，否则 Obsidian 不会加载新的 TypeScript 改动。
- 构建后要把 `main.js`、`manifest.json`、`styles.css` 重新同步到测试 vault。
- 如果改动涉及真实 Obsidian UI，静态构建不等于实际验证，需要在 Obsidian 中手测。
