# 程序包瘦身（2026-11-03）

状态：**范围已定（用户 2026-11-03），在做**。分支 `studio/package-slim`（worktree `G:\PROJECT\AgentMonitorOverlay-package-slim`），合并等用户说。

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

打好的平台模式包在 `G:\PROJECT\AgentMonitorOverlay-package-slim\studio\release\platform\`。先关掉正在用的 Studio 再开它（两个 Studio 用同一个数据目录会抢）；或者用环境变量 `AMO_STUDIO_DATA_DIR` 给它一个临时数据目录。

1. `AMO Studio\AMO Studio.exe` 打开，主界面和看板正常。
2. 新建任务，Claude 会话发一句，能回。
3. Codex 会话发一句，能回。
4. DSH（DeepSeek）会话发一句，能回。
5. 任务页点 Review，Git Review 窗口打开；点一个文件链接，查看器打开。
6. 便签随 Studio 起来，在托盘里；快捷键能呼出。
7. `AMO Reviewer\AMO Reviewer.exe <某个 git 文件夹>`：独立 Reviewer 打开改动。
8. `AMO Relay\AMO Relay.exe`：中转客户端打开、登录。
9. `AMO Platform\AMO Platform.exe`：平台打开，「工具」页正常。

## 提交顺序（`studio/package-slim`）

1. 方案（本文件）。
2. `check-package.mjs` + 瘦身前的白名单（行为不变）。
3. e2e 的 `AMO_E2E_APP`，瘦身前跑一遍记结果。
4. 复制过滤（R2–R4）。
5. 工作区包去重 + 转发文件（R1）。
6. 瘦身后的 import 检查、冒烟、e2e；各工具 `CHANGELOG.md`「## 下一版」、`HANDOFF.md`。

## 结果

（做完填）
