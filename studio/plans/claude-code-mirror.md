# Claude Code 镜像（团队服务器）+ 平台一键安装、更新

分支 `studio/claude-code-mirror`，worktree `G:\PROJECT\AgentMonitorOverlay-claude-code-mirror`。2026-11-03 开始。Claude Code 做完接着做 Codex（用户 2026-11-03）。

## 要做什么

装、更新 Claude Code 很慢，还容易断：官方脚本单线程一次下完 335 MB 的 exe，不能续传，断了从头来。改成：

- **团队服务器**（中转服务）定时查官方有没有新版，有就在后台下好、校验好，在局域网里提供。管理页能设置、看状态。
- **AMO 平台「环境」页**：Claude Code 没装时给「安装」，官方安装的有新版时给「更新」。先从团队服务器下，服务器没有就从官方下，两边都能续传。

## 用户定的（2026-11-02 同意方向，11-03 确认下面这些）

1. 服务器**每小时**查一次官方 `latest`，**保留最近 3 版**，管理页可以改。
2. **只跟 latest 通道**（和官方安装脚本、本机默认一致）；stable 先不做，以后在管理页加开关。
3. **只下 win32-x64**，arm64 在管理页可以打开。
4. **版本以服务器备好的为准**：服务器上有就装那版，服务器正在下更新的版本时写「团队服务器正在准备 x.y.z（n%）」；服务器没有或连不上时才从官方下 latest。
5. **Claude Code 自己的自动更新不管**（要改 `~/.claude` 的设置，我们不碰）。
6. **代理先不做**（Mac 直连官方约 6.7 MB/s）。
7. **服务器存 `.zst` 压缩包**（122 MB，exe 是 335 MB），局域网和 Tailscale 都省流量。
8. 改了中转服务，部署（`npm run release -- relay-service`）前先问用户。

## 调查结论（2026-11-02，临时 HOME + 记流量的本地代理实测，Claude Code 2.1.316）

- 官方地址 `https://downloads.claude.ai/claude-code-releases`：`/latest`、`/stable` 返回纯文本版本号（当时 2.1.316 / 2.1.309）；`/<版本>/manifest.json` 有每个平台的 `checksum`（exe 的 sha256）和 `size`；`/<版本>/<平台>/claude.exe`（335 MB）和 `claude.exe.zst`（122 MB），都支持 Range。清单里没有 zst 自己的校验值：解压后对 exe 的 sha256。
- `install.ps1` 实际是 `bootstrap.ps1`：拿 latest → 清单 → 下 exe → 校验 → `claude.exe install <Target>`。
- **`claude.exe install <版本>` 会自己再从官方下一遍 zst**（114 秒，122 MB），哪怕运行的就是这个版本。
- **先把 exe 放到 `%USERPROFILE%\.local\share\claude\versions\<版本>`** 再 `install <版本>`：只拿两个十来 KB 的小文件，7 秒；断网也能装好（8 秒）。`claude update` 碰到新版已经放好，也不下载。
- 放进去的文件内容不对时，`install` 发现并从官方重下对的（多一层保险）。
- 升级地址写死在 Claude Code 里，没有环境变量能改：它自己的后台更新只能走官方。
- 装好后的样子：`.local\bin\claude.exe`（复制）+ `.local\share\claude\versions\<版本>`。
- Mac：Node 26（自带 zstd）、Homebrew 有 zstd、磁盘剩 3.1 TB。平台的 Electron 44 也自带 zstd。

## 做法

### 服务器（`packages/relay/src/mirror.ts`）

- 目录：`<数据目录>/mirror/`（deploy 不碰数据目录）。`settings.json` 存设置，`claude-code/index.json` 存已备好的版本，`claude-code/<版本>/manifest.json`（官方原样）、`claude-code/<版本>/<平台>/claude.exe.zst`。
- **检测**：按设置的间隔（默认 60 分钟）GET `/latest`（15 秒超时）。新版本先拿清单，再按设置的平台逐个下。管理页「现在检查」立刻查一次；正在查时不重复开。
- **下载**：写 `.part`；已有 `.part` 就带 `Range: bytes=<已下>-` 接着下（回 200 就从头来）；60 秒没收到数据算卡住，断开重连；失败等 30 秒、1、2、4、5 分钟再试，一轮最多 6 次，还不行就记下错误，等下一次检查（`.part` 留着，接着下）。
- **校验**：zst 流式解压，边解边算 sha256 和字节数，和清单的 `checksum`、`size` 对上才把 `.part` 改成正式文件名、写进 `index.json`；对不上删掉 `.part`，记错误。
- **保留**：备好的版本按版本号留最新 N 版（默认 3），旧的整个目录删掉；没下完的旧版本也删。
- **设置**：开关（默认开）、检查间隔（10–1440 分钟）、平台（win32-x64 / win32-arm64）、保留几版（1–10）。改了马上生效。
- **接口**：
  - 管理页（管理密码）：`GET /api/admin/mirror`（设置、状态、已备好的版本），`POST /api/admin/mirror/settings`，`POST /api/admin/mirror/check`。
  - 平台（要登录，和平台别的文件一样）：`GET /api/platform/mirror/claude-code`（备好的版本和各平台文件大小、sha256；官方最新；正在准备的版本和进度），`GET /platform/mirror/claude-code/<版本>/manifest.json`，`GET /platform/mirror/claude-code/<版本>/<平台>/claude.exe.zst`（支持 Range）。
- **管理页**加一张「Claude Code 镜像」卡片：设置表单、状态（官方最新、服务器已有、上次检查、下载进度和速度、错误）、「现在检查」；下载中每几秒刷新。

### 平台（`packages/platform/src/claude-install.ts` + `environment.ts` + 环境页）

- **最新版本**：官方安装或没装时，「最新」= 服务器备好的最新版；没登录、连不上、服务器没有时问官方 `/latest`；npm 装的照旧问 npm。
- **安装 / 更新**（没装，或官方安装的有新版）：
  1. 定版本和来源：服务器备好的 → 从服务器下；否则官方 latest → 从官方下。
  2. 清单先直接找官方拿（10 秒超时），拿不到用服务器那份；取 `platforms.<win32-x64|win32-arm64>`（按 `PROCESSOR_ARCHITECTURE`）。
  3. 下 zst 到 `%APPDATA%\AMO\downloads\claude-code\<版本>-<平台>.exe.zst.part`，续传（Range）、30 秒没数据算卡住、断了重试 3 次。别的版本留下的 `.part` 先删掉。
  4. 解压到 `versions\<版本>.amo-tmp`，边解边算 sha256，对上清单才改名成 `versions\<版本>`（已经有且 sha256 对的就跳过）。
  5. 运行 `versions\<版本> install <版本>`（5 分钟上限），再重新检测。
- npm 装的照旧 `npm install -g`；别的方式装的不在这里更新。
- 界面：进度条显示真实百分比、已下多少、从哪里下（团队服务器 / 官方）；服务器在准备更新的版本时写出来。「复制安装命令」留着，作为兜底。

## 分步

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 方案 | ✓ |
| 1 | 中转：`mirror.ts`（检测、续传下载、校验、保留、设置）+ 单测（假的官方服务器：断流、Range、校验失败） | ○ |
| 2 | 中转：接口（平台的要登录、zst 支持 Range）+ 管理页卡片 + 服务启动时带上 | ○ |
| 3 | 平台：`claude-install.ts`（选来源、续传、校验、放进 versions、`install`）+ 单测 | ○ |
| 4 | 平台：环境页（安装按钮、真实进度、来源和服务器准备中的提示）+ e2e 截图 | ○ |
| 5 | 收尾：CHANGELOG、HANDOFF、中转 README；告诉用户部署中转 | ○ |
| 6 | Codex 镜像（先调查，和用户谈定再做） | ○ |

## 约束

- 更新只在人点的时候做（2026-10-29）；平台不在后台替人预下载。
- 不改 `~/.claude` 的设置；登录凭据不通过环境变量传。
- 不装平台，各工具照旧自己检测；服务器没有镜像时平台照样从官方装。
- 部署中转服务前先问用户。
