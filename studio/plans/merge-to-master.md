# 合并到 master：检查单

**状态：等你决定（NEEDS_YOU S8-07）。loop 不合并、不推送。**

截至 2026-10-14：`studio/main` 比 `master`（`ac93b81`）多 115 个提交，`master` 上没有 `studio/main` 没有的提交，所以合并不会有冲突。

## 合并会带进 master 的东西

| 内容 | 说明 |
|---|---|
| `studio/` | 整个新版（代码、测试、文档、截图 3.5 MB、预研记录） |
| `docs/next-gen-vision-architecture-2026-10.md`、`docs/protocol-session-spike-2026-10-12.md` | 新版的设计文档（提交 `2acd722`、`93e437a`） |
| **`75ac787 fix: drop agents.default_subagent overrides rejected by Codex 0.161`** | **旧 AMO 的 DeepSeek 修复，还在等你验证**（NEEDS_YOU 最早那一条）。它在这条分支的历史里，合并 studio 会一起带进 master。如果你还没验证，可以先验证，或者告诉我用 `git revert` 在合并前把它撤出来 |

不会带进去：`studio/.data/`、`studio/release/`、`node_modules/`、`test-results/`（都在 `.gitignore` 里，已确认没有被跟踪）。

## 自查结果

- **密钥**：扫描了 `studio/` 下所有被跟踪的文本文件，没有发现密钥、令牌或私钥。
- **个人信息**：三个早期的预研结果里有你的 Windows 用户名（本机路径），已替换成 `%USERPROFILE%`。截图 `screenshots/stage-8/S8-02-setup.png` 里能看到临时目录路径（含用户名）；如果仓库是公开的、你介意，告诉我，我把这张截图打码或换掉。
- **红线**：全部测试只在 `%TEMP%` 下的沙箱里跑；端口只用 47900–47999；测试窗口在屏幕外、不抢焦点；没有改过 `~/.codex`、`~/.claude`、凭据管理器、旧 AMO 的运行时和数据。
- **验证**：`npm run verify` 219 个测试通过；e2e 40 个全部通过；Portable 产物冒烟通过。

## 合并之后、你要决定的

- 旧 AMO 的代码先不删（S3-10 等你）；合并后 master 上新旧并存，互不依赖。
- 根目录的 `README.md` 仍然是旧 AMO 的；要不要先在顶部加一行"新版见 `studio/`"。
- 是否推送到 GitHub、是否发 Release（Studio 的 zip）。

## 合并的做法（你同意后）

1. 在 `studio/main` 上再跑一次完整验证和 e2e。
2. 切到 `master`，`git merge --no-ff studio/main`，提交信息写明"AMO Studio 阶段 0–8"。
3. 不推送，除非你另外说"推送"。
