# 合并到 master：检查单

> 状态：做完（2026-10-17，`studio/main` 快进进 master 并推送，`02aa0722`；旧版留在标签 `amo-legacy-final`）；只留下一处截图含用户名，见下。10-14 时的检查单（提交数、自查和验证的数字、合并步骤）2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。

## 当时定的

- 合并前自查过：被跟踪的文件里没有密钥；预研结果里的本机路径换成了 `%USERPROFILE%`。没处理的一处：截图 `screenshots/stage-8/S8-02-setup.png` 里能看到临时目录路径（含 Windows 用户名），仓库公开前要打码或换掉（2026-11-06 还在仓库里）。
- 带进 master 的有 `studio/` 和两份设计文档（`docs/next-gen-vision-architecture-2026-10.md`、`docs/protocol-session-spike-2026-10-12.md`）；`studio/.data/`、`studio/release/`、`node_modules/`、`test-results/` 都在 `.gitignore` 里，不进仓库。
- 旧 AMO 的 DeepSeek 修复 `75ac787`（`fix: drop agents.default_subagent overrides rejected by Codex 0.161`）在这条分支的历史里，随合并一起进了 master。
- 合并后新旧并存了几天；旧 AMO 的代码 10-23 删掉，根目录 `README.md` 改写成 Studio 的介绍（见 `plans/done/remove-old-amo.md`）。
