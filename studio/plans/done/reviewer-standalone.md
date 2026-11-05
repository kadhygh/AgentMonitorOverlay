# Reviewer 独立（2026-10-23）

> 状态：做完（2026-10-23，R1 `5e13b10b`、R2 / R3 `fbea7448`；Portable 和平台都有独立的 AMO Reviewer，Studio 包里也带着）。留下没做、也没排期的：独立 Reviewer 没有 MCP（外部模型用命令行 `amo-review --reviewer`）；Studio 里的 `review_open` / `view_open` 仍开 Studio 自己的窗口；独立 Reviewer 的批注历史在它自己的数据库里，和 Studio 的分开。进度一节 2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。

用户出门前给的决定（memory `studio-reviewer-standalone`），回来一起审：

1. Reviewer（Git Review、查看器、查看包）像便签一样拆成独立程序，别的 LLM 也能用。
2. **去掉「LLM 拉起 Reviewer → 人批注 → 一键发回对话（选会话）」的最后一步**：选会话没有意义。改成：人写了批注后，两个按钮——**复制注释**、**复制并关闭**。
3. Reviewer 不是由 AMO 拉起时，书签相关的都不显示。
4. 借机整理 Reviewer 的布局和结构。

## 怎么做的（三步）

1. **R1 复制代替发回**：Git Review、查看器文件模式、改动预览的「发回会话」改成「复制注释 / 复制并关闭」；复制的文字和原来发给会话的一样（文件、行、原文、批注）；复制后这些批注标为已发出（离开草稿列表），提示「已复制 N 条批注」。Host 的接口是 `POST /api/workspaces/:id/review-comments/copy`。MCP `review_open` / `view_open` 的说明改成「人会把批注复制给你」。
2. **R2 结构整理**：页面入口 `reviewer.html`（像 `notes.html`，只有 Git Review 和查看器）；`window.amo.app === "reviewer"` 时不显示书签（`lib/where.ts`、`MarkButton`）。
3. **R3 独立程序** `packages/reviewer`：Reviewer 的窗口模块（`review-window.ts`、`viewer-window.ts`、`viewer-rules.ts`，从 app 挪来，Studio 从这个包引入）+ 独立程序 `main.ts`：自带一个不接模型的 Host、自己的数据目录 `%APPDATA%\AMO Reviewer\data`、单实例、最后一个窗口关掉就退出。`amo-review --reviewer` 用它（没在跑就带着文件夹启动它）；开发时 `npm run reviewer -- <文件夹>`。e2e 在 `e2e/reviewer/`。

Studio 里的 `review_open` / `view_open` 先照旧走 Studio 自己的窗口，等独立程序稳定后再考虑切过去（10-23 定，之后没再动）。
