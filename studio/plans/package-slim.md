# 程序包瘦身（2026-11-03）

状态：**做完，已 rebase 到 master（41d7f2d1）并重新验证过（2026-11-03），可以合并；合并等用户说**。分支 `studio/package-slim`（worktree `G:\PROJECT\AgentMonitorOverlay-package-slim`），合并等用户说。

## 为什么

平台按「每个文件 + sha256」装和更新（这套保留，不改成整包）。问题是文件太多：Studio 0.9.28 有 11211 个文件、378 MB。第一次安装时每个对象要发一次 HTTP 请求，每装一个版本要建一万多个文件（复制或硬链接），`file-index.json` 和清单也跟着变大。清单的传输已经单独处理过（d24941e5），这里只减文件数。

## 范围（用户定的，只做低风险的）

做：

1. 工作区包去掉重复的一份（`packages/` 和 `node_modules/@amo-studio/` 的双份）。
2. node_modules 里的 `.map`。
3. `.d.ts`（`.d.mts`、`.d.cts`）。
4. node_modules 里 README、CHANGELOG、`*.md`、测试、示例、配置这类非运行文件。

不做：去掉 `@anthropic-ai/sdk` 及只有它要的包；codex 生成的 `export {}` 空 .js；`.ts` / `.mts` 源码；字体合并；主进程代码打成一个文件。

许可证：LICENSE、NOTICE、COPYING 这类文件每个包照原样留着，不合并、不删（包括放在测试目录里的也不动）。

## 现在怎么打的包

`scripts/package-portable.mjs`（`package:portable` 和 `package:platform` 都用它，五个工具都用它）：

1. 复制 Electron 的 `dist`，只留中英文 locale。
2. 每个工作区包：`packages/<pkg>/dist`（滤掉 `.map`、`.tsbuildinfo`、`*.test.js`）、`package.json`、`assets` 复制到 `resources/app/packages/<pkg>/`。
3. **重复的来源**：`protocol host reviewer relay account locate traymenu` 这七个包会再复制一份 `dist` 到 `resources/app/node_modules/@amo-studio/<pkg>/`。开发时 npm workspace 用符号链接，`@amo-studio/x` 就是 `packages/x`；打包时把链接换成了真复制，所以有两份。
4. 依赖：从各包 `dependencies` 出发，整包复制依赖闭包。

谁按路径用、谁按包名用（决定哪份能去掉）：

| 包 | 按路径用 | 按包名 `@amo-studio/x` 用 |
|---|---|---|
| app、notes、platform、relay-app | `launch.js` 的 MAINS | 没有 |
| ui | `packages/ui/dist`（界面） | 没有（vite 已经把 protocol 内联） |
| host | `packages/host/dist/bin.js`（app 起 Host 进程）；`../../assets/codex`；`features/maintenance` 往上 5 级找根目录 | app `setup.ts`、reviewer `main.ts` 进程内 `startHost` |
| reviewer | Reviewer 的 MAINS | app `main.ts`、`marks-window.ts` |
| protocol、account、locate、traymenu、relay | 没有 | 有 |

顺带发现：进程内用的是 `node_modules/@amo-studio/host` 那份，它没带 `assets`，`maintenance` 往上 5 级算出的根目录是 `resources/app/node_modules`。去重以后进程内和 Host 进程用的是同一份 `packages/host`，这两处跟着变对。

## 估算（在服务器上 0.9.28 的同一份文件夹上模拟，按顺序叠加）

| # | 去掉什么 | Studio 文件 | 大小 |
|---|---|---|---|
| R1a | 库包（protocol、account、locate、traymenu、relay）只留 `node_modules/@amo-studio` 一份 | −1605 | −1.1 MB |
| R1b | host、reviewer 的 `node_modules/@amo-studio` 副本换成转发文件 | −360 | −1.6 MB |
| R2 | node_modules 的 `.map` | −1703 | −4.9 MB |
| R3 | `.d.ts` / `.d.mts` / `.d.cts`（codex 生成类型的 .d.ts 也在里面） | −2569 | −9.1 MB |
| R4a | README、CHANGELOG、HISTORY、AUTHORS、CONTRIBUTING、`*.md` | −159 | −1.1 MB |
| R4b | `test`、`tests`、`__tests__`、`example(s)`、`docs`、`.github`、`benchmark` 目录（含 zod `src/**/tests`） | −359 | −2.6 MB |
| R4c | `.eslintrc`、`.nycrc`、`.editorconfig`、`.prettier*`、`.nvmrc`、`.npmignore`、`tsconfig*.json` 等 | −65 | 很小 |
| | **合计** | **11211 → 约 4390** | 378.5 → 约 358 MB |

| 工具 | 现在 | 之后（约） |
|---|---|---|
| AMO Studio | 11211 | 4390 |
| AMO Reviewer（主工作区 0.9.8 的包） | 10980 | 4300 |
| AMO 中转客户端 | 3857 | 1810 |
| AMO 便签 | 3436 | 1110 |
| AMO 平台 | 404 | 350 |

实际数字以打出来的为准，写在下面「结果」里。

## 为什么安全

- **去重**：库包没有被按路径读的地方（查过 `import.meta.url`、`studioRoot`、`package.json` 的读法：只有 relay 的 `bin.ts` 用到，那是服务端）。host、reviewer 两边都要：真文件放 `packages/<pkg>`，`node_modules/@amo-studio/<pkg>/` 里只放 `package.json` 和按它 `exports` 生成的转发文件（`export * from "../../../packages/host/dist/index.js"`），和开发时符号链接的效果一样。目标模块有 `export default` 时打包报错（`export *` 不转发 default）。
- **`.map`、`.d.ts`**：运行时不读；Studio 没开 `--enable-source-maps`，我们自己的 `dist` 早就不带 `.map`。
- **文档、测试、示例、配置**：没有运行时代码引用（`has-symbols/test/index.js` 只被同目录的测试引用）。
- 一律保留 `package.json` 和其他 `.json`：平台和 host 都读已装 Studio 的 `node_modules/@anthropic-ai/claude-agent-sdk/package.json`（`claudeCodeVersion`）。

## 怎么改（都在打包脚本里，开发环境、dist、各包 package.json 不动）

1. `scripts/check-package.mjs <程序文件夹>`：扫 `resources/app` 下每个 `.js/.mjs/.cjs` 里写死的 `import … from`、`export … from`、`import("…")`、`require("…")`。相对路径的必须找得到文件（CJS 按 Node 规则补 `.js`、`.json`、`/index.js`）；包名的必须在某一级 `node_modules` 里有，`exports` / `main` 指向的文件存在；`node:`、内置模块、`electron` 跳过。瘦身前先跑一遍，找不到的（可选依赖、try/catch 里的 require）记进白名单 `scripts/check-package.allow.json`；package-portable 最后自动跑，多出白名单以外的就失败。
2. `package-portable.mjs`：一个复制过滤 `shipped()`，所有 `cpSync` 走它（R2–R4）。
3. 工作区包按上表分类：只按路径用的放 `packages/`，只按包名用的放 `node_modules/@amo-studio/`，两者都是的生成转发文件。
4. 输出里加文件数。

## 验证

1. **import 检查**：五个工具的平台包，瘦身前后都跑 `check-package.mjs`，瘦身后不能多出找不到的。
2. **便携包冒烟**：`node scripts/smoke-portable.mjs release`（Studio 首次运行、建任务、和模拟模型聊天、拉起便签；独立 Reviewer；独立便签）。
3. **e2e 用打好的包跑，前后对比**：`e2e/support/studio.ts` 加开关 `AMO_E2E_APP=<程序文件夹>`（`executablePath` 用打好的 exe，不再传 `main.js`）。瘦身前的包跑一遍 `studio`、`notes`、`reviewer`，瘦身后再跑同样的，结果必须一样。
4. **真模型（合并前请用户点）**：见下面「请你点的」。

## 请你点的（合并前）

都在 `G:\PROJECT\AgentMonitorOverlay-package-slim\studio\release\`。正在用的 Studio 不用关。

Studio 用便携版（`release\AMO Studio`，内容和平台版一样，只是 exe 带图标），**双击 `release\try-slim-studio.cmd` 打开**：它让瘦身版的 Host 用空闲端口（不和正在用的 Studio 抢 47900），数据放在 `release\AMO Studio\data`（第一次打开会问，选默认就行），不碰你平时的数据。不要直接开 `release\platform\AMO Studio`：平台版会去读平台设置里的 Studio 数据目录，也就是你平时那份。

1. `try-slim-studio.cmd` 打开 Studio，看板正常。新数据目录里没有模型的话，在 设置 → 模型 里加。
2. 新建一个任务（项目随便选个文件夹），Claude 会话发一句，能回。
3. Codex 会话发一句，能回。
4. DSH（DeepSeek）会话发一句，能回。
5. 任务页点 Review，Git Review 窗口打开；点回复里的一个文件链接，查看器打开。
6. 便签：你平时的便签开着时，Studio 只会把它叫出来（同一时间只开一个），测不到瘦身版的。要测就先在托盘里退出平时的便签，再开 `release\AMO Notes\AMO Notes.exe`，快捷键能呼出、能写。
7. `release\AMO Reviewer\AMO Reviewer.exe <某个 git 文件夹>`（命令行），独立 Reviewer 打开改动。
点完关掉这些窗口；瘦身版 Studio 从托盘「完全退出」。

中转客户端和平台**不要**从这里手动开：它们用的是 `%APPDATA%\AMO`、`%APPDATA%\AMO Relay` 里和平时共用的文件（中转会把 `amo-relay.cmd` 改成指向这里的 exe，平台会把这个文件夹当成它的根目录）。这两个用 e2e 的 `platform`、`relay` 两个 project 在临时目录里前后对比（打好的文件夹先复制到 `%TEMP%`，e2e 改不到 `release\`）。

## 提交顺序（`studio/package-slim`）

1. 方案（本文件）。
2. `check-package.mjs` + 瘦身前的白名单（行为不变）。
3. e2e 的 `AMO_E2E_APP`。
4. 复制过滤（R2–R4）和工作区包去重（R1）一个提交（都在 `package-portable.mjs` 里，拆开意义不大）；打完自动跑 import 检查、输出文件数、删掉过滤后留下的空目录。
5. 结果、各工具 `CHANGELOG.md`「## 下一版」、`HANDOFF.md`。

## 结果

平台模式打包（`npm run package:platform`），同一份 dist，瘦身前打到 `release/before/`，瘦身后打到 `release/platform/`：

| 工具 | 瘦身前 | 瘦身后 | 程序部分（resources/app） | LICENSE/NOTICE/COPYING（前 → 后） |
|---|---|---|---|---|
| AMO Studio | 11211 | 4392 | 58 → 37 MB | 104 → 104 |
| AMO Reviewer | 11125 | 4340 | 57 → 37 MB | 104 → 104 |
| AMO 中转客户端 | 3857 | 1804 | 17 → 9 MB | 96 → 96 |
| AMO 便签 | 3436 | 1114 | 19 → 18 MB | 1 → 1 |
| AMO 平台 | 404 | 351 | 18 → 18 MB | 0 → 0 |

- **import 检查**：瘦身前五个工具找不到的都记进了白名单（Studio 135 处：`bufferutil`、`utf-8-validate`、`ejs`、`re2`、`@cfworker/json-schema` 这些可选依赖，node_modules 里测试文件要的 `tape`，JSDoc 里的 `import('./types/index')`）；瘦身后五个都是「白名单以外 0 处」。第一次跑时它抓到 `side-channel-list` 的 JSDoc `import('./list.d.ts')`，那不是运行时的 import，检查改成不管指向 `.d.ts` 的。
- **e2e（打好的包，`AMO_E2E_APP`）**：`notes` + `reviewer` 瘦身前后都是 9 过 1 败，败的是同一条（`notes-todo.spec.ts:190` 要版本号带「开发版」，打好的包本来就不带，和瘦身无关）。
- **e2e `studio`（197 条，打好的包）**：瘦身前 188 过 9 败（27.5 分钟），瘦身后 189 过 8 败（33.5 分钟）。瘦身后败的 8 条都在瘦身前那 9 条里，没有新的；少的那条是 `viewer-review.spec.ts:51`（位置差 0.12 像素，时好时坏）。这 8 条是打好的包和开发版本来就不一样的地方，用打好的包跑本来就过不了：`maintenance.spec.ts` 两条（要「源码 · git 工程」，打好的包是「启动自便携版」）、`model-channels.spec.ts:316`（要「SDK 附带的（源码运行）」，打好的包用本机装的 Claude Code）、`portable.spec.ts:20`（它自己模拟首次运行，打好的包启动方式不同）、`cli.spec.ts:35`、`task-head.spec.ts:22`、`tray.spec.ts:35`、`turn-start.spec.ts:74`。要让这些在打好的包上也过，得给它们各加「打好的包」的分支，这次不做。
- **e2e `platform`、`relay`（打好的文件夹复制到 `%TEMP%` 再跑）**：前后一样，`platform` 2 过 6 败、`relay` 2 过 5 败，失败的是同一批。这两个 project 在打好的包上能证明的不多：平台模式的中转客户端要求在 AMO 平台里登录（页面停在「在 AMO 平台里登录」，用例要的是自己的注册页）。打好的平台连测试服务器的几条也一样过不了。能看出来的是：瘦身后的中转客户端能启动、从服务器取到界面、连上服务器（页面显示「服务器在线」）；平台能启动，「环境」页和「没有写权限」两条通过。中转 `issues-page` 两条不开客户端，前后都过。
- **便携包冒烟**（`npm run package:portable` 的 zip，`smoke-portable.mjs`）：都过。Studio 解压、首次运行选数据目录、用本机的 Claude Code（2.1.316）和模拟模型聊天、拉起便签、文件夹外什么都没写；独立 Reviewer 打开改动；独立便签启动。zip：Studio 158 MB、Reviewer 158 MB、便签 151 MB、平台 151 MB。
- 截图抽看：界面、字体和 master 上的截图一致（e2e 截图没提交，已还原）。
- 用户试过（维护总管转达，2026-11-03）：Reviewer 正常；便签没打开是因为平时的便签开着（只开一个，被拿到前面），不是瘦身的问题。

### rebase 到 master 之后（2026-11-03，master 41d7f2d1）

master 新加了 Claude Code / Codex 镜像（平台「环境」页）、平台安装重试、DeepSeek 用 DSH 桌面版账号或 Key 登录、Claude 多账号、便签托盘切换修复。冲突只有 `platform.spec.ts` 的 import 行和 CHANGELOG / HANDOFF，按两边都留解决。

- **import 检查抓到 master 自己的问题**：`@amo-studio/relay` 从镜像那次起依赖 `@amo-studio/locate/download`（`index.js` → `server.js` → `mirror.js`），但 `amo-tools.mjs` 里中转的包列表没有 locate，所以从 master 打的下一个中转客户端一启动就会 `ERR_MODULE_NOT_FOUND`，和瘦身无关（瘦身前的打包脚本一样不带它）。已发的中转 0.9.5 在镜像之前，没受影响。修法：中转的包列表加上 `locate`（单独一个提交）。用打好的 `AMO Relay.exe`（`ELECTRON_RUN_AS_NODE`）加载 `@amo-studio/relay`：带 locate 能加载（63 个导出），删掉 locate 就是 `ERR_MODULE_NOT_FOUND`。
- **import 检查**：五个工具白名单以外都是 0 处。
- **新功能会不会读被去掉的文件**：查了 master 这几次提交在各包 `src` 里新加的代码，没有按路径读程序文件夹的（没有新的 `import.meta.url` / `createRequire` / `node_modules` / `assets` 路径）。Claude 多账号读写的是 `~/.claude-accounts` 和默认的 `~/.claude`，DSH 账号登录读 `~/.dsh/.credentials.yaml`、把补丁写进数据目录，都不在程序文件夹里。master 删掉的 `host/assets/codex/deepseek-flash.models.json` 也没人再读。
- **便携包冒烟**：都过（和上面同样的几步）。
- 文件数（rebase 后，瘦身前用 master 的打包脚本打一份对比）：

| 工具 | 瘦身前 | 瘦身后 |
|---|---|---|
| AMO Studio 0.9.29 | 11230 | 4396 |
| AMO Reviewer 0.9.10 | 11144 | 4344 |
| AMO 中转客户端 0.9.5（带上 locate） | 3871 | 1808 |
| AMO 便签 0.9.9 | 3436 | 1114 |
| AMO 平台 0.9.18 | 414 | 355 |

- 没重跑 e2e（总管说 check-package 和冒烟没发现瘦身的问题就不用）。
