# Markdown Annotation Tools

一个最小可用的 Obsidian 插件，用来处理 `[!anno]...[/anno]` 批注。

## 功能

- 在阅读模式下，把 `[!anno]批注内容[/anno]` 渲染成高亮批注块
- 提供按钮和命令，一键提取当前笔记中的批注内容并复制到剪切板
- 提供编辑命令，把选中文本包裹成批注语法
- 提供追加命令，在当前笔记末尾快速新增一条批注

## 使用方式

### 1. 写入批注

直接在笔记中写：

```md
[!anno]这里是一条批注[/anno]
```

也可以在编辑模式下使用命令：

- `用 [!anno]...[/anno] 包裹当前选中内容`
- `向当前笔记末尾追加批注`

### 2. 复制批注内容

你可以通过以下任一入口复制当前笔记里的批注正文：

- 左侧 Ribbon 的剪贴板图标
- 当前 Markdown 视图右上角的剪贴板按钮
- 命令面板中的 `复制当前笔记中的批注到剪切板`

复制结果只包含批注正文，不包含 `[!anno]` 和 `[/anno]` 标签。

## 开发

```bash
npm install
npm run build
```

构建产物包括：

- `main.js`
- `manifest.json`
- `styles.css`

把它们放进你的 vault：

```text
.obsidian/plugins/md-anno-tools/
```
