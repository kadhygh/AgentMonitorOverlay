# 删除旧 AMO

> 状态：做完（2026-10-23，`ea939abf` 删掉旧 AMO，`00a9792b` 清掉本机残留；旧版在标签 `amo-legacy-final`）。还剩一处没做：根目录的 `THIRD_PARTY_NOTICES.md` 还是旧 AMO 的（写的是 Tauri、`overlay/`、`broker/` 的依赖），没按 Studio 的依赖重写。10-14 列的逐个路径和文件数 2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。

## 怎么定的

- **删**：旧 AMO 的代码和运行：`broker/`（Hook 接收、任务卡片、会话路由）、`overlay/`（Tauri 前端）、旧的 `scripts/`、`tools/canvas-mcp-test/`、`examples/`、`amo.ps1`、`amo.local.example.json`、`.github/workflows/release-portable.yml`。都由 `studio/` 里的东西替代，git 历史和 tag 里都还在。
- **挪走不删**：`docs/` 里旧 AMO 的设计、任务记录和旧手册（`DEVELOPMENT`、`PROJECT_PLAN`、`USER_SESSION_MANUAL`）放进 `docs/archive-old-amo/`。
- **留**：`studio/` 原位不动（提到根目录要改所有路径，风险大）；`docs/next-gen-vision-architecture-2026-10.md`、`docs/protocol-session-spike-2026-10-12.md`（Studio 的设计依据）；`LICENSE`；`.gitignore`（只删旧 AMO 的条目）。
- 根 `README.md` 和 `package.json` 改成指向 `studio/`。
- 本机不在 git 里的旧数据（`broker/data/`、构建输出等）留给用户自己处理。

## 要知道的

- 旧 AMO 往工程里部署过 Hook（`.codex/hooks.json`、`.grok/hooks/amo.json`、`.claude/settings.local.json` 里的 Hook、`.amo/`）。删掉后这些 Hook 找不到后台，CLI 里可能报 Hook 失败，要逐个工程清掉（10-23 本机已清）。
- 旧 AMO 的「Git exclude」会把 `.amo/` 写进工程的 `.git/info/exclude`。（扩展包 2026-10-31 已删掉，格式说明在 `docs/archive/pack-format.md`）
- 旧 AMO 启动的 Codex / Claude 可能让 agent 的命令读到模型密钥（阶段 4 发现，Studio 已修）；删掉旧 AMO 后这个问题不再存在。
