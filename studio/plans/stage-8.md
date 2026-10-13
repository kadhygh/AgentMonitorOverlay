# 阶段 8 · 发布与收尾

分支：`studio/stage-8`（从 `studio/main` 创建）。范围和关卡见 `ROADMAP.md`：Portable 打包（不再维护安装包）、首次启动设置、删除旧 AMO 代码（以你在 S3-10 的回复为前提）、文档；**合并到 master 由你确认**。

依据：ROADMAP 阶段 8；你的方向"Portable-only release"；已有的技术事实——Store 用 Node 自带的 `node:sqlite`（没有原生模块要打包），Host 由 Electron 自己的 Node 启动（`ELECTRON_RUN_AS_NODE`），Claude 运行时用 Agent SDK 自带的 `claude.exe`，Codex 用你本机装的 `codex`。

## 哪些能做、哪些等你

| 内容 | 做法 |
|---|---|
| Portable 打包 | **可以做**：只在 `studio/` 下装打包工具（锁版本），产物输出到 `studio/release/`（不进 git）；打包后的程序只在沙箱数据目录、测试模式下启动验证 |
| 首次启动设置 | **可以做**：只影响 Studio 自己 |
| 文档 | **可以做** |
| 删除旧 AMO 代码 | **等你**（S3-10 还没回复）。loop 只会写一份"要删哪些文件"的清单，不删任何东西 |
| 合并到 master | **等你**（S8-07）。loop 不会合并，也不会推送 |

## 已确定的做法

| 项目 | 做法 | 说明 |
|---|---|---|
| 打包方式 | 不引入打包工具：复制 Electron 运行时、改名 exe、Studio 放在 `resources/app/`（不打 asar），依赖从已安装的 `node_modules` 拷贝（S8-00） | 不做安装包、不签名、不联网 |
| 产物 | `AMO-Studio-<版本>-portable.zip`，解压即用；里面是 `AMO Studio.exe` 和资源 | |
| 数据目录 | 默认放在 exe 旁边的 `data/`（便携：整个目录拷走就带走数据）；首次启动时可以改到别处，选择记在 exe 旁边的 `amo-studio.json` | 开发模式仍用 `studio/.data` |
| 首次启动 | 没有 `amo-studio.json` 时先进设置页：选数据目录；检查 `codex` 是否在 PATH、凭据管理器里有没有 DeepSeek/GLM 的条目（只读，不显示密钥）；然后才启动 Host | |
| 版本号 | `0.8.0`（阶段 8），以后按阶段递增 | 默认决定 |
| 额度 | 打包产物冒烟用 mock；如果要验证真实模型，GLM 1 次 | |

## 任务

### S8-00 预研：打包方式 · done（结论见 `spikes/RESULTS.md` 第 k 节）
- 依赖：无
- 内容：在临时目录里试两种打包方式，看：产物大小；Host 能否用打包后的 Electron 启动；UI 静态文件和 Host 的 dist 怎么放；Agent SDK 自带的 `claude.exe` 能否从 asar 外面找到；启动时间。结论写进 `spikes/RESULTS.md`。
- 验收：结论与实测数据。

### S8-01 打包后的运行路径 · done
- 依赖：S8-00
- 内容：`packages/app` 在打包后找得到 Host、UI、preload；Host 找得到 Agent SDK 的 `claude.exe`；开发模式不受影响。
- 验收：单测（路径解析）；打包产物在测试模式下启动、Host 回应。

### S8-02 首次启动设置 · done
- 依赖：S8-01
- 内容：设置页（数据目录、环境检查），写 `amo-studio.json`；以后启动直接用。
- 验收：单测；e2e（测试模式下用临时目录模拟 exe 目录）。

### S8-03 打包脚本与产物冒烟 · done
- 依赖：S8-01、S8-02
- 内容：`npm run package:portable` 生成 zip；`release/` 进 `.gitignore`；脚本把 zip 解到沙箱目录，用 mock 模型跑一遍：启动 → 首次设置 → 新建任务 → 对话 → 退出，确认没有写到沙箱以外。
- 验收：脚本输出与截图。

### S8-04 文档 · done
- 内容：`studio/README.md` 改成使用说明（下载解压、首次设置、和旧 AMO 的对应关系、常见问题）；`docs/` 里的架构说明更新到实际实现。

### S8-05 删除旧 AMO 的清单（不删） · todo
- 内容：`plans/remove-old-amo.md`：列出旧 AMO 的目录和文件、它们和 Studio 的对应关系、删除后 master 上剩什么；等你回复 S3-10 后才执行。

### S8-06 全面自查与合并准备 · todo
- 依赖：S8-01～S8-05
- 内容：跨阶段的自查（安全、红线、遗留待办）；完整验证；列出合并到 master 的检查单（会带进 master 的文件、和 master 现有内容的冲突、`studio/.data` 等不进 git 的确认）。

### S8-07 【必须等你】合并到 master · 等你（S8-06 完成后写入 NEEDS_YOU）
- 内容：S8-06 完成后写进 NEEDS_YOU。你回复"同意合并"之前，loop 不合并、不推送。

### S8-08 【必须等你】删除旧 AMO · 等你（即 S3-10）

## 预算预估

GLM 0～1 次，DeepSeek 0 次。

## 带过来的待办

- 第一个真实扩展包（S6-09）、派发（S5-10）、调度权限与频率（S7-09，含定时运行 S7-06）都在等你。
- 交接终端里的 Claude 不带 AMO MCP。
- Codex mock 会话调 MCP 的用例偏慢（约 25 秒），待查。
- 部分测试的临时目录偶尔留下。
