# Reviewer 独立（2026-10-23）

用户出门前给的决定（memory `studio-reviewer-standalone`），回来一起审：

1. Reviewer（Git Review、查看器、查看包）像便签一样拆成独立程序，别的 LLM 也能用。
2. **去掉「LLM 拉起 Reviewer → 人批注 → 一键发回对话（选会话）」的最后一步**：选会话没有意义。改成：人写了批注后，两个按钮——**复制注释**、**复制并关闭**。
3. Reviewer 不是由 AMO 拉起时，书签相关的都不显示。
4. 借机整理 Reviewer 的布局和结构。

## 现状（拆之前）

- 界面：`ui/src/gitreview`（Git Review 窗口 `#review`）、`ui/src/viewer`（查看器 `#viewer`，文件 + 改动）、`ui/src/viewpacks`（查看包）、`ui/src/files`（文件预览、链接）。
- 用到的 Host 接口约 20 个：git（status / changes / diff / log / commit / commit-diff）、批注（`/api/workspaces/:id/review-comments` 增删改 + `send`）、查看包（`/api/viewpacks/:id`、`…/items/:item/diff`）、文件（`/api/fs/text|raw|exists`）、打开方式（`/api/open-in`、`/api/open-in/apps`）；AMO 才有的：书签（`/api/bookmarks`、`/api/file-marks`、`/api/chat-marks`）、会话（`/api/sessions/:id/messages`、`…/annotations`）。还用 `/api/state` 的 workspaces / sessions。
- 发回会话：`gitreview/comments.tsx` 的 `SendBar`（Git Review 和查看器文件模式）、`viewpacks/ProposalItemView.tsx` 的 `viewpack-send`；Host `features/gitreview` 的 `send`。

## 步骤

1. **R1 复制代替发回**（在 Studio 里先做，行为变化）：`SendBar` 改成「复制注释 / 复制并关闭」；复制的文字和原来发给会话的一样（文件、行、原文、批注）；复制后这些批注标为已发出（离开草稿列表），提示「已复制 N 条批注」。改动预览的批注同样。MCP `review_open` / `view_open` 的说明改成「人会把批注复制给你」。
2. **R2 结构整理**：Reviewer 的界面代码归到一处，单独的页面入口 `reviewer.html`（像 `notes.html`）；书签相关的按钮只在 AMO 里出现（独立运行时 `window.amo` 没有书签接口就不显示）。
3. **R3 独立程序** `packages/reviewer`：Electron + 本机小服务（同便签的做法），实现上面那些接口（git、文件、批注、查看包），打开方式：命令行 `amo-review <目录> [--file … --line …]`、MCP；批注存在它自己的目录里。Studio 里的 `review_open` / `view_open` 先照旧走 Studio 自己的窗口，等独立程序稳定后再切过去。

每步提交并跑测试；不推送。

## 进度

（随做随记）
