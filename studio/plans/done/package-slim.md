# 程序包瘦身（2026-11-03）

> 状态：做完（2026-11-03 合进 master，`5d3c57e9`；随 Studio 0.9.30、Reviewer 0.9.11、便签 0.9.10、平台 0.9.19、中转 0.9.6 发布）。Studio 的文件数 11230 → 4396。估算表、给用户点的试用步骤、提交顺序、逐项的 e2e 和冒烟结果 2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。

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

## 打包怎么放工作区包

`scripts/package-portable.mjs`（`package:portable` 和 `package:platform` 都用它，五个工具都用它）把每个工作区包的 `dist`、`package.json`、`assets` 放进 `resources/app`。开发时 npm workspace 用符号链接，`@amo-studio/x` 就是 `packages/x`；打包时链接换成真复制，原来就会有两份。现在按谁怎么用来放：

| 包 | 按路径用 | 按包名 `@amo-studio/x` 用 | 放在哪 |
|---|---|---|---|
| app、notes、platform、relay-app | `launch.js` 的 MAINS | 没有 | `packages/` |
| ui | `packages/ui/dist`（界面） | 没有（vite 已经把 protocol 内联） | `packages/` |
| host | `packages/host/dist/bin.js`（app 起 Host 进程）；`../../assets/codex`；`features/maintenance` 往上 5 级找根目录 | app `setup.ts`、reviewer `main.ts` 进程内 `startHost` | 真文件在 `packages/`，`node_modules/@amo-studio/host` 里只放转发文件 |
| reviewer | Reviewer 的 MAINS | app `main.ts`、`marks-window.ts` | 同 host |
| protocol、account、locate、traymenu、relay | 没有 | 有 | `node_modules/@amo-studio/` |

去重以前，进程内用的是 `node_modules/@amo-studio/host` 那份，它没带 `assets`，`maintenance` 往上 5 级算出的根目录是 `resources/app/node_modules`；去重以后进程内和 Host 进程用的是同一份 `packages/host`，这两处跟着变对。

## 为什么安全

- **去重**：库包没有被按路径读的地方（查过 `import.meta.url`、`studioRoot`、`package.json` 的读法：只有 relay 的 `bin.ts` 用到，那是服务端）。host、reviewer 两边都要：真文件放 `packages/<pkg>`，`node_modules/@amo-studio/<pkg>/` 里只放 `package.json` 和按它 `exports` 生成的转发文件（`export * from "../../../packages/host/dist/index.js"`），和开发时符号链接的效果一样。目标模块有 `export default` 时打包报错（`export *` 不转发 default）。
- **`.map`、`.d.ts`**：运行时不读；Studio 没开 `--enable-source-maps`，我们自己的 `dist` 早就不带 `.map`。
- **文档、测试、示例、配置**：没有运行时代码引用（`has-symbols/test/index.js` 只被同目录的测试引用）。
- 一律保留 `package.json` 和其他 `.json`：平台和 host 都读已装 Studio 的 `node_modules/@anthropic-ai/claude-agent-sdk/package.json`（`claudeCodeVersion`）。
- 下面的 `check-package.mjs` 只看写死的 import：代码要是按路径去读被去掉的文件（README、测试目录、`.d.ts`），它查不出来。合并前查过 master 新加的代码，没有这样读程序文件夹的（新的 `import.meta.url` / `createRequire` / `node_modules` / `assets` 路径）。

## 改了什么（都在打包脚本里，开发环境、dist、各包 package.json 不动）

1. `scripts/check-package.mjs <程序文件夹>`：扫 `resources/app` 下每个 `.js/.mjs/.cjs` 里写死的 `import … from`、`export … from`、`import("…")`、`require("…")`。相对路径的必须找得到文件（CJS 按 Node 规则补 `.js`、`.json`、`/index.js`）；包名的必须在某一级 `node_modules` 里有，`exports` / `main` 指向的文件存在；`node:`、内置模块、`electron` 跳过；指向 `.d.ts` 的（JSDoc 里的 `import('…d.ts')`）不管。瘦身前就找不到的（可选依赖、try/catch 里的 require、测试文件要的包）记在白名单 `scripts/check-package.allow.json`；package-portable 最后自动跑，多出白名单以外的就失败。
2. `package-portable.mjs`：一个复制过滤 `shipped()`，所有 `cpSync` 走它；工作区包按上表放；打完删掉过滤后留下的空目录，输出里有文件数。
3. e2e 加开关 `AMO_E2E_APP=<打好的程序文件夹>`：用打好的 exe 跑 `studio`、`notes`、`reviewer`、`platform`、`relay`（平台和中转的先复制到 `%TEMP%`）。

## 已知的

- 用打好的包跑 e2e，`studio` 有 8 条本来就过不了（和瘦身无关，是打好的包和开发版不一样的地方）：`maintenance.spec.ts` 两条、`model-channels.spec.ts:316`、`portable.spec.ts:20`、`cli.spec.ts:35`、`task-head.spec.ts:22`、`tray.spec.ts:35`、`turn-start.spec.ts:74`；`notes-todo.spec.ts:190` 要版本号带「开发版」。要让它们在打好的包上也过，得各加「打好的包」的分支，这次不做。平台模式的中转客户端要求在 AMO 平台里登录，`platform`、`relay` 两个 project 在打好的包上能证明的不多。
- import 检查第一次就抓到一个 master 自己的问题：`@amo-studio/relay` 从工具镜像起要 `@amo-studio/locate/download`，所以中转的包列表（`amo-tools.mjs`）要带 `locate`（`e2901e8f`）。
