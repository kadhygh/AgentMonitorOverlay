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
  3. 下 zst 到平台文件夹的 `downloads\claude-code\claude-<版本>-<平台>.exe.zst.part`，续传（Range）、30 秒没数据算卡住、断了重试 3 次。别的版本留下的 `.part` 先删掉。
  4. 解压到 `versions\<版本>.amo-tmp`，边解边算 sha256，对上清单才改名成 `versions\<版本>`（已经有且 sha256 对的就跳过）。
  5. 运行 `versions\<版本> install <版本>`（5 分钟上限），再重新检测。
- npm 装的照旧 `npm install -g`；别的方式装的不在这里更新。
- 界面：进度条显示真实百分比、已下多少、从哪里下（团队服务器 / 官方）；服务器在准备更新的版本时写出来。「复制安装命令」留着，作为兜底。

## 分步

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 方案 | ✓ |
| 1 | 中转：`mirror.ts`（检测、续传下载、校验、保留、设置）+ 单测（假的官方服务器：断流、Range、校验失败） | ✓ `3b9a3622` |
| 2 | 中转：接口（平台的要登录、zst 支持 Range）+ 管理页卡片 + 服务启动时带上 | ✓ `3b9a3622` |
| 3 | 平台：`claude-install.ts`（选来源、续传、校验、放进 versions、`install`）+ 单测 | ✓ `f2f42560` |
| 4 | 平台：环境页（安装按钮、真实进度、来源和服务器准备中的提示）+ e2e 截图 | ✓ `f2f42560` |
| 5 | 收尾：CHANGELOG、HANDOFF、中转 README；告诉用户部署中转 | ✓ `a3577cda` |
| 6 | 中转：镜像按工具（Claude Code、Codex），管理页两组设置 | ✓ |
| 7 | 平台：`codex-install.ts`；环境页改成「团队服务器 / 官方」两块（Claude Code 也是）；没 npm、独立安装版的说明；e2e 截图 | ✓ |
| 8 | 收尾：CHANGELOG、README、HANDOFF | ✓ |

## 做的时候定下的细节（2026-11-03）

- 续传和 zst 校验是共用模块 `@amo-studio/locate/download`（服务器和平台都用）。
- 服务器只在带平台目录启动时（也就是团队服务器）默认开镜像；`--mirror` 强制开、`--no-mirror` 关。本机试服务、e2e 都不会自己去下 122 MB。第一次检查在服务启动 30 秒后。
- 平台的半截下载放在平台自己的文件夹 `downloads\claude-code\`（和工具的 `apps\` 一样在平台文件夹里），不放 `%APPDATA%`。
- ~~从服务器下时：401/403/404 或断两次，就接着从官方下~~（11-03 改：两块由人选，从服务器没下成就停下说原因、提示点「官方」那一行；服务器存的是官方原样的文件，同一个 `.part` 换着点也能接着续）。
- `versions\<版本>` 已经有且 sha256 对（比如 Claude Code 自己的后台更新先下好了），就不下载，只跑 `install`。

## 验证（2026-11-03）

- 单测：`mirror.test.ts` 10 条（断流续传、卡住续传、校验失败、保留 N 版、设置、官方连不上、接口的 Range / 416 / 401 / 404），`claude-install.test.ts` 5 条，`environment.test.ts` 新加 1 条；relay、platform、locate、testkit 共 177 条全过。
- 真实流程：本机起打包后的服务（`--mirror`），从官方真实下了 2.1.316 的 zst（122,064,664 字节）并按官方清单校验通过；平台的 `installClaude` 从这个服务装进临时用户目录，共 10.1 秒，`claude install` 时给了坏代理也装好了，`claude --version` 是 2.1.316。
- e2e：平台的两条「环境」用例通过（新加的用 testkit 的假镜像，curl.exe 当 Claude Code），截图 `screenshots/platform/P38–P40`。整组平台 e2e 里另有 6 条登录后「正在连接」超过 5 秒失败，master 上同一条也失败，和这次改动无关（机器忙时的超时，没再查）。
- 管理页卡片：浅色、深色截图看过（下载中、进度、设置表单）。

### Codex 和「两块」（2026-11-03 第二轮）

- 单测：`mirror.test.ts` 12 条（加 Codex：断流续传、sha512 不对、设置各管各的、接口按工具），`codex-install.test.ts` 5 条（两处来源、续传、npm 连不上时用服务器的 sha512、对不上不装、npm 失败留下核对过的 .tgz 下次不再下、独立版识别），`claude-install.test.ts` 改成两块（服务器没文件不再自动换官方；断了的 `.part` 换官方接着续），`environment.test.ts` 改写那条（两块、没 npm、npm 装的 Codex、独立版的说明）；relay、platform、locate、testkit、平台界面共 184 条全过，类型检查通过。
- 真实流程：本机起服务（`--mirror`），两个镜像都从官方真实下好、核对通过（Codex 0.166.0 的平台包 180,706,795 字节，Claude Code 这时已是 2.1.317，122,895,826 字节）；`installCodex` 从这个服务装进临时的 npm 前缀和缓存（没碰本机的全局 npm）：下载 + 核对 1 秒，`npm cache add` + `npm install -g` 共 15 秒，npm 的日志里大包是 `cache hit`（不加 `--prefer-offline` 也是），`codex --version` 是 `codex-cli 0.166.0`。
- e2e：平台「环境」三条通过；新截图 `P41-codex-needs-npm`、`P42-codex-installing`、`P43-codex-installed`，P17/P18/P36–P40 跟着变（两块的样子；P36/P37 现在是 npm 装的 Codex 从官方更新）。整组平台 e2e 还是那 6 条「正在连接」失败，和这次无关。
- 管理页两张卡片浅色、深色截图看过（空、备好）。

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

### 做法

- 服务器：`mirror.ts` 改成按工具的来源（Claude Code：Anthropic 的 latest + 清单 + zst；Codex：npm 的 latest + 每个平台包的 dist + tgz），同一套检测、续传、保留、设置。目录 `mirror/codex/<版本>/<平台>/codex-<版本>-<平台>.tgz`；`settings.json` 里 `"codex"` 一组。接口 `/api/platform/mirror/<工具>`、`/platform/mirror/<工具>/<版本>/<平台>/<文件>`；管理接口带 `tool`。
- 平台：`codex-install.ts`：下 tgz 到 `downloads\codex\`（续传），sha512 先对 npm 官方的 `dist.integrity`，连不上 npm 时用服务器记的；`npm cache add` + `npm install -g @openai/codex@<版本>`，成功后删掉下载的文件。
- 两块各下各的：从服务器下没成功就停下说原因、提示可以点官方那块，不再自动换官方（下了一半的文件两边是同一份内容，换着点会接着下）。

## 约束

- 更新只在人点的时候做（2026-10-29）；平台不在后台替人预下载。
- 不改 `~/.claude` 的设置；登录凭据不通过环境变量传。
- 不装平台，各工具照旧自己检测；服务器没有镜像时平台照样从官方装。
- 部署中转服务前先问用户。
