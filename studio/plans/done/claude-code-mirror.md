# 工具镜像（团队服务器）+ 平台「环境」页安装、更新 Claude Code 和 Codex

> 状态：做完（2026-11-03 合进 master：Claude Code `a016680c`、`f9e777c9`，Codex 和「两块」`d1aa3aaf`、`9dcd9aba`；随 AMO 平台 0.9.17、中转服务 0.7.9 发布）。分步表、验证记录（单测条数、真实下载的字节数和耗时、截图编号）2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。原来的分支 `studio/claude-code-mirror` 已经合进 master。

## 要做什么

装、更新 Claude Code 很慢，还容易断：官方脚本单线程一次下完 335 MB 的 exe，不能续传，断了从头来。改成：

- **团队服务器**（中转服务）定时查官方有没有新版，有就在后台下好、校验好，在局域网里提供。管理页能设置、看状态。
- **AMO 平台「环境」页**：Claude Code 没装时给「安装」，官方安装的有新版时给「更新」。团队服务器和官方两处都能下，都能续传。

Claude Code 做完接着做 Codex（用户 2026-11-03）。

## 用户定的（2026-11-02 同意方向，11-03 确认下面这些）

1. 服务器**每小时**查一次官方 `latest`，**保留最近 3 版**，管理页可以改。
2. **只跟 latest 通道**（和官方安装脚本、本机默认一致）；stable 先不做，以后在管理页加开关。
3. **只下 win32-x64**，arm64 在管理页可以打开。
4. ~~版本以服务器备好的为准，服务器没有或连不上时才从官方下 latest~~（11-03 改，见下面 Codex 第 2 条：环境页分「团队服务器」「官方」两块，由人点）。服务器正在下更新的版本时写「团队服务器正在准备 x.y.z（n%）」。
5. **Claude Code 自己的自动更新不管**（要改 `~/.claude` 的设置，我们不碰）。
6. **代理先不做**（Mac 直连官方约 6.7 MB/s）。
7. **服务器存 `.zst` 压缩包**（122 MB，exe 是 335 MB），局域网和 Tailscale 都省流量。
8. 改了中转服务，部署（`npm run release -- relay-service`）前先问用户。

## Claude Code 调查结论（2026-11-02，Claude Code 2.1.316）

- 官方地址 `https://downloads.claude.ai/claude-code-releases`：`/latest`、`/stable` 返回纯文本版本号；`/<版本>/manifest.json` 有每个平台的 `checksum`（exe 的 sha256）和 `size`；`/<版本>/<平台>/claude.exe`（335 MB）和 `claude.exe.zst`（122 MB），都支持 Range。清单里没有 zst 自己的校验值：解压后对 exe 的 sha256。
- `install.ps1` 实际是 `bootstrap.ps1`：拿 latest → 清单 → 下 exe → 校验 → `claude.exe install <Target>`。
- **`claude.exe install <版本>` 会自己再从官方下一遍 zst**（114 秒，122 MB），哪怕运行的就是这个版本。
- **先把 exe 放到 `%USERPROFILE%\.local\share\claude\versions\<版本>`** 再 `install <版本>`：只拿两个十来 KB 的小文件，7 秒；断网也能装好。`claude update` 碰到新版已经放好，也不下载。
- 放进去的文件内容不对时，`install` 发现并从官方重下对的（多一层保险）。
- 升级地址写死在 Claude Code 里，没有环境变量能改：它自己的后台更新只能走官方。
- 装好后的样子：`.local\bin\claude.exe`（复制）+ `.local\share\claude\versions\<版本>`。
- Mac：Node 26（自带 zstd）、Homebrew 有 zstd。平台的 Electron 44 也自带 zstd。

## Codex（2026-11-03 调查、用户确认）

### 调查结论（Codex 0.166.0）

- npm 的 `@openai/codex` 主包只有 13 KB，程序在平台包里：`@openai/codex@<版本>-win32-x64`（`https://registry.npmjs.org/@openai/codex/-/codex-<版本>-win32-x64.tgz`，180,706,795 字节，解开 502 MB），npm 给 `dist.integrity`（sha512），支持 Range。`/@openai%2fcodex/latest` 是正式版的版本号（不含 alpha）。
- **先 `npm cache add <平台包.tgz>` 再 `npm install -g @openai/codex@<版本>`**：5 秒装好，只从网上拿了 5 MB 的包信息（packument）和 13 KB 的主包，大包直接用缓存（npm 按 sha512 找）。npm 自己装也会在缓存里留这一份，不多占。
- 官方另有 `install.ps1`（独立安装）：装到 `%USERPROFILE%\.codex\packages\standalone\releases\<版本>-<target>`，`%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` 是指过去的目录链接，还改 PATH、管 daemon。太复杂，平台不替它装。

### 用户定的（2026-11-03）

1. 服务器镜像 npm 的平台包（原样存，sha512 核对），每小时查 npm 的 `latest`，只要 win32-x64（arm64 可开），保留 3 版；管理页里 Claude Code、Codex 各一组设置。
2. **环境页分两块**（Claude Code 也一样）：服务器有备好的版本时显示「团队服务器」一块（版本 + 安装按钮）；「官方」一块总是显示（官方最新版 + 安装按钮）。装哪个由人点，不再自动选。服务器正在准备新版时照旧写出来。
3. 没有 npm 时：两块照样显示版本，按钮不能点，写明「要先装 Node.js（自带 npm）」并给下载页。
4. 官方独立安装脚本装的 Codex：面板里写明是独立安装版、平台不更新它（它自己更新，或重新运行官方安装命令）。
5. Codex 正在运行时照旧不更新，提示先完全退出 Studio。

## 做法

### 服务器（`packages/relay/src/mirror.ts`）

- 按工具的来源，同一套检测、续传、保留、设置：Claude Code 是 Anthropic 的 latest + 清单 + zst；Codex 是 npm 的 latest + 每个平台包的 dist + tgz。
- 目录：`<数据目录>/mirror/`（deploy 不碰数据目录）。`settings.json` 存设置（每个工具一组），`claude-code/index.json` 存已备好的版本，`claude-code/<版本>/manifest.json`（官方原样）、`claude-code/<版本>/<平台>/claude.exe.zst`；Codex 是 `codex/<版本>/<平台>/codex-<版本>-<平台>.tgz`。
- **检测**：按设置的间隔（默认 60 分钟）问 latest（15 秒超时）。新版本先拿清单，再按设置的平台逐个下。管理页「现在检查」立刻查一次；正在查时不重复开。
- **下载**：写 `.part`；已有 `.part` 就带 `Range: bytes=<已下>-` 接着下（回 200 就从头来）；60 秒没收到数据算卡住，断开重连；失败等 30 秒、1、2、4、5 分钟再试，一轮最多 6 次，还不行就记下错误，等下一次检查（`.part` 留着，接着下）。
- **校验**：Claude Code 的 zst 流式解压，边解边算 sha256 和字节数，和清单的 `checksum`、`size` 对上才把 `.part` 改成正式文件名、写进 `index.json`；Codex 对 sha512。对不上删掉 `.part`，记错误。
- **保留**：备好的版本按版本号留最新 N 版（默认 3），旧的整个目录删掉；没下完的旧版本也删。
- **设置**：开关（默认开）、检查间隔（10–1440 分钟）、平台（win32-x64 / win32-arm64）、保留几版（1–10）。改了马上生效。
- **接口**：管理页（管理密码）`GET /api/admin/mirror`、`POST /api/admin/mirror/settings`、`POST /api/admin/mirror/check`（带 `tool`）；平台（要登录，和平台别的文件一样）`GET /api/platform/mirror/<工具>`（备好的版本和各平台文件大小、校验值；官方最新；正在准备的版本和进度）、`GET /platform/mirror/<工具>/<版本>/<平台>/<文件>`（支持 Range）。
- **管理页**每个工具一张卡片：设置表单、状态（官方最新、服务器已有、上次检查、下载进度和速度、错误）、「现在检查」。
- 只在带平台目录启动时（也就是团队服务器）默认开镜像；`--mirror` 强制开、`--no-mirror` 关。本机试服务、e2e 都不会自己去下 122 MB。第一次检查在服务启动 30 秒后。

### 平台（`packages/platform/src/claude-install.ts`、`codex-install.ts`、`tool-mirror.ts`、`environment.ts` + 环境页）

- 续传和校验是共用模块 `@amo-studio/locate/download`（服务器和平台都用）。
- **Claude Code**（没装，或官方安装的有新版）：清单先直接找官方拿，拿不到才用服务器那份（服务器出了错也塞不进别的文件）；取 `platforms.<win32-x64|win32-arm64>`（按 `PROCESSOR_ARCHITECTURE`）。下 zst 到平台文件夹的 `downloads\claude-code\`（续传、卡住重连、断了重试；别的版本留下的 `.part` 先删掉）→ 解压到 `versions\<版本>.amo-tmp`，边解边算 sha256，对上才改名成 `versions\<版本>` → 运行 `versions\<版本> install <版本>`，再重新检测。`versions\<版本>` 已经有且 sha256 对（比如 Claude Code 自己的后台更新先下好了），就不下载，只跑 `install`。npm 装的照旧 `npm install -g`；别的方式装的不在这里更新。
- **Codex**：下 tgz 到 `downloads\codex\`（续传），sha512 先对 npm 官方的 `dist.integrity`，连不上 npm 时用服务器记的；`npm cache add` + `npm install -g @openai/codex@<版本>`，成功后删掉下载的文件。
- **两块各下各的**：从服务器下没成功就停下说原因、提示可以点「官方」那一行，不再自动换官方（11-03 改）。服务器存的是官方原样的文件，同一个 `.part` 换着点也能接着续。
- 半截下载放在平台自己的文件夹 `downloads\`（和工具的 `apps\` 一样在平台文件夹里），不放 `%APPDATA%`。
- 界面：进度条显示真实百分比、已下多少、从哪里下；服务器在准备更新的版本时写出来。「复制安装命令」留着，作为兜底。

## 约束

- 更新只在人点的时候做（2026-10-29）；平台不在后台替人预下载。
- 不改 `~/.claude` 的设置；登录凭据不通过环境变量传。
- 不装平台，各工具照旧自己检测；服务器没有镜像时平台照样从官方装。
- 部署中转服务前先问用户。
