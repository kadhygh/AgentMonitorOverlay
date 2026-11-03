# 程序包瘦身（2026-11-03）

状态：**方案，等用户确认**。分支 `studio/package-slim`（worktree `G:\PROJECT\AgentMonitorOverlay-package-slim`）。

## 为什么

平台按「每个文件 + sha256」装和更新（这套保留，不改成整包）。问题是文件太多：Studio 0.9.28 有 11211 个文件、378 MB。第一次安装时每个对象要发一次 HTTP 请求，每装一个版本要建一万多个文件（复制或硬链接），`file-index.json` 和清单也跟着变大。清单的传输已经单独处理过（d24941e5），这里只减文件数。

## 现在怎么打的包

`scripts/package-portable.mjs`（`package:portable` 和 `package:platform` 都用它，五个工具都用它）：

1. 复制 Electron 的 `dist`，只留中英文 locale。
2. 每个工作区包：`packages/<pkg>/dist`（滤掉 `.map`、`.tsbuildinfo`、`*.test.js`）、`package.json`、`assets` 复制到 `resources/app/packages/<pkg>/`。
3. **重复的来源**：`protocol host reviewer relay account locate traymenu` 这七个包会再复制一份 `dist` 到 `resources/app/node_modules/@amo-studio/<pkg>/`。开发时 npm workspace 用符号链接，`@amo-studio/x` 就是 `packages/x`；打包时把链接换成了真复制，所以有两份。
4. 依赖：从各包 `dependencies` 出发，整包复制依赖闭包（`.d.ts`、源码、README、测试一个不落）。

谁按路径用、谁按包名用（决定哪份能去掉）：

| 包 | 按路径用 | 按包名 `@amo-studio/x` 用 |
|---|---|---|
| app、notes、platform、relay-app | `launch.js` 的 MAINS | 没有 |
| ui | `packages/ui/dist`（Studio、便签、Reviewer 的界面） | 没有（打包时 vite 已经把 protocol 内联） |
| host | `packages/host/dist/bin.js`（app 起 Host 进程）；`../../assets/codex`；`features/maintenance` 往上 5 级找根目录 | app `setup.ts`、reviewer `main.ts` 进程内 `startHost` |
| reviewer | Reviewer 的 MAINS | app `main.ts`、`marks-window.ts` |
| protocol、account、locate、traymenu、relay | 没有 | 有 |

顺带发现：进程内用的是 `node_modules/@amo-studio/host` 那份，它没带 `assets`，`maintenance` 往上 5 级算出的根目录是 `resources/app/node_modules`，都是现在就有的小毛病。去重以后进程内和 Host 进程用的是同一份 `packages/host`，这两处跟着变对。

## 实测（服务器上 0.9.28 的同一份文件夹：`AgentMonitorOverlay-release/studio/release/platform/AMO Studio`）

每条规则按顺序叠加，后一条不重复算前一条已经去掉的。

| # | 去掉什么 | Studio 文件 | 大小 |
|---|---|---|---|
| R1 | `@anthropic-ai/sdk` 和只有它要的 6 个包（json-schema-to-ts、ts-algebra、@babel/runtime、standardwebhooks、fast-sha256、@stablelib/base64） | −3212 | −13.2 MB |
| R2a | 库包（protocol、account、locate、traymenu、relay）只留 `node_modules/@amo-studio` 一份 | −1605 | −1.1 MB |
| R2b | host、reviewer 的 `node_modules/@amo-studio` 副本换成转发文件（见下） | −360 | −1.6 MB |
| R3 | protocol 里没人 import 的 codex 生成类型（只剩 `export {}` 的 .js） | −1473 | −0.4 MB |
| R4a | `.d.ts` / `.d.mts` / `.d.cts` | −1167 | −4.3 MB |
| R4b | `.map` | −478 | −2.0 MB |
| R4c | 源码 `.ts` / `.mts` / `.cts` / `.tsx` | −454 | −3.3 MB |
| R5 | node_modules 里的 README、CHANGELOG、`*.md`；LICENSE 并成一个文件 | −245 | −0.9 MB |
| R6 | node_modules 里的 `test`、`tests`、`__tests__`、`example(s)`、`docs`、`.github`、`benchmark` 目录 | −160 | −1.0 MB |
| R7 | node_modules 里的 `.eslintrc`、`.nycrc`、`.editorconfig`、`.prettier*`、`.nvmrc`、`tsconfig*.json` 等 | 约 −62 | 很小 |
| | **合计** | **11211 → 约 2000** | 378.5 → 约 350 MB |

各工具（同一套规则模拟；Reviewer 用的是主工作区 `release/platform` 里 0.9.8 的包，其余是 0.9.28 那次打包目录里的）：

| 工具 | 现在 | 之后（约） |
|---|---|---|
| AMO Studio | 11211 | 2000 |
| AMO Reviewer | 10980 | 1900 |
| AMO 中转客户端 | 3857 | 1450 |
| AMO 便签 | 3436 | 380 |
| AMO 平台 | 404 | 350 |

剩下的大头（Studio）：ui 286（其中字体子集 203）、hono 383、zod 258、host 174、ajv 146、@modelcontextprotocol/sdk 125。这些在后面「可选的第二、三步」里。

体积几乎不变：378 MB 里 321 MB 是 Electron（平台已经在各工具间硬链接共用）。这次省的是文件数。

## 每一条为什么安全

- **R1 `@anthropic-ai/sdk`**：host 的 `package.json` 写着它，只是为了满足 `@anthropic-ai/claude-agent-sdk` 的 peerDependency。agent SDK 的 `sdk.mjs`、`core*.mjs`、`bridge.mjs` 里一次都没有 import 它（只 import `zod/v4`、`@modelcontextprotocol/sdk/server/*`、`ajv`）；我们自己的 `packages/*/src` 也没有。只在类型里用到。打包时跳过它（和现在跳过 Claude Code 本体 `claude-agent-sdk-win32-x64` 一样写在 `skipDeps`），开发环境不动。
- **R2 去重**：
  - 库包只放 `node_modules/@amo-studio/<pkg>`，它们没有被按路径读的地方（查过 `import.meta.url`、`studioRoot`、`package.json` 的读法：只有 relay 的 `bin.ts` 用到，那是服务端，客户端不走）。
  - host、reviewer 两边都要：真文件放 `packages/<pkg>`，`node_modules/@amo-studio/<pkg>/` 里只放 `package.json` 和按它 `exports` 生成的转发文件（`index.js`：`export * from "../../../packages/host/dist/index.js"`；relay 的 `./light` 同理）。这和开发时符号链接的效果一样。打包时检查目标模块没有 `export default`（`export *` 不转发 default），有就报错。
- **R3 codex 类型**：`protocol/dist/codex/**` 是生成的 TypeScript 类型，编译出来的 .js 只有 `export {};`。运行时只加载 `codex/index.js` → `codex/v2/index.js`（`export * as v2`）和 `codex/VERSION.js`。做法不写死 codex 目录：**我们自己的包里，内容只有 `export {}` 而且没有任何留下的模块 import 它的 .js 不带**。以后重新生成 codex 类型也照样成立。
- **R4 类型、source map、源码**：运行时不读。我们自己的 `dist` 早就不带 `.map`，Studio 也没开 `--enable-source-maps`。zod 等包 `exports` 里有指向 `.ts` 的自定义条件（`@zod/source`），Node 不用这个条件。
- **R5 许可证**：MIT 等许可证要求随副本带上许可声明，所以 LICENSE 不是删，是合并：打包时写一个 `resources/app/THIRD-PARTY-LICENSES.txt`（每个包：名字、版本、许可证文件原文；没有文件的写 `package.json` 的 `license` 字段）。Electron 自己的 `LICENSE`、`LICENSES.chromium.html` 不动。
- **R6、R7**：测试、示例、配置文件，没有运行时代码引用它们（`has-symbols/test/index.js` 只被同目录的测试引用）。

**两个读路径的地方要保住**：平台读已装 Studio 的 `resources/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json`（`claudeCodeVersion`），host 也读它；`package.json` 和 `.json` 一律保留，所以没问题。

## 怎么改（都在 `scripts/package-portable.mjs`，开发环境、dist、package.json 不动）

1. **一个复制过滤函数** `shipped(path, { thirdParty })`，所有 `cpSync` 都走它：R4、R6、R7；第三方包另外去掉 README / CHANGELOG / `*.md`，LICENSE 收集起来最后写进 `THIRD-PARTY-LICENSES.txt`。
2. **工作区包分两类**：按路径用的（有 MAINS 的、host、ui）放 `packages/`；只按包名用的放 `node_modules/@amo-studio/`；两者都是的（host、reviewer）生成转发文件。分类由一张小表写清理由，不靠猜。
3. **`skipDeps` 加上 `@anthropic-ai/sdk`**（Studio、Reviewer），注释写清只是 peer 依赖。
4. **去掉没人 import 的空模块**（R3），只扫我们自己的包。
5. **打包后自检** `scripts/check-package.mjs <程序文件夹>`（package-portable 最后自动跑，失败就不算打好）：
   - 扫 `resources/app` 下每个 `.js/.mjs/.cjs` 里写死的 `import … from`、`export … from`、`import("…")`、`require("…")`；
   - 相对路径的必须找得到文件（CJS 按 Node 的规则补 `.js`、`.json`、`/index.js`）；包名的必须在某一级 `node_modules` 里有，并且 `exports` / `main` 指向的文件存在；`node:` 和内置模块、`electron` 跳过；
   - 先对现在的包（瘦身前）跑一遍，把找不到的（比如 `ws` 的可选依赖 `bufferutil`、写在 try/catch 里的 require）记成带理由的白名单；之后瘦身的包不能多出新的。
6. 输出里加文件数：`{ files: 2003, removed: { types: …, maps: … } }`，方便发布时一眼看出有没有变多。

## 验证

1. **静态**：`check-package.mjs` 对五个工具的平台包和 portable 包都过（上面第 5 条）。
2. **便携包冒烟**：`node scripts/smoke-portable.mjs release`（已有）：Studio 首次运行、建任务、和模拟模型聊天（走 Claude Agent SDK）、拉起便签；独立 Reviewer 打开改动；独立便签启动。
3. **e2e 用打好的包跑**：`e2e/support/studio.ts` 加一个开关 `AMO_E2E_APP=<程序文件夹>`：有它时 `executablePath` 用 `<文件夹>\<Name>.exe`、不再传 `packages/app/dist/main.js`。A/B 对比：
   - 先用**瘦身前**的包跑 `studio`、`notes`、`reviewer` 三个 project，记下结果（打包模式下本来就过不了的用例，会在这一步暴露出来，和瘦身无关）；
   - 再用瘦身后的包跑同样的用例，结果必须一样。
   - 低优先级、`--workers` 收着跑。
4. **加载记录对比（可选的一层保险）**：用瘦身前的包跑冒烟和 e2e 时，记下主进程和 Host 进程实际加载过的每个文件（`AMO_TRACE_MODULES=1` 时用 `module.registerHooks` 的 resolve 钩子记，只在打包出的 `launch.js` 和 Host 启动处加，平时不注册），再确认这些文件在瘦身后的包里都还在。实现超过半天就不做，以 1～3 为准。
5. **真模型（要你点，我没法替你登录）**：我打好平台模式的 Studio 放在 worktree 的 `release/platform/AMO Studio`，你在里面各发一句：Claude、Codex、DSH 会话；开一次 Reviewer（Review 改动 + 查看器）和便签。中转客户端打开、登录一次。平台本身：打开、看「工具」页。
6. **平台安装**：不部署、不发布。合进 master 后照常走 `npm run release` 发到测试通道；第一次装瘦身版时，旧文件全都已经在本机，只会新下载转发文件和许可证汇总这几个，装完文件数应该和打包输出一致。这一步在发布时看，不在这个分支做。

## 提交顺序（每步一个提交，在 `studio/package-slim`）

1. `check-package.mjs` + 对现在的包跑出白名单（行为不变）。
2. 复制过滤（R4–R7）+ 许可证汇总。
3. 跳过 `@anthropic-ai/sdk`（R1）。
4. 工作区包去重 + 转发文件（R2）。
5. 去掉没人 import 的空模块（R3）。
6. e2e 的 `AMO_E2E_APP`，A/B 跑完；各工具 `CHANGELOG.md`「## 下一版」写一句（程序包文件从多少减到多少），`HANDOFF.md` 加一条。合并等你说。

## 可选的第二、三步（这次不做，先问你）

- **字体**：`packages/ui` 的 203 个 `.woff2` 是 fontsource 按 unicode-range 切的 Noto Sans SC（98）、Noto Serif SC（100）、JetBrains Mono（5）。换成每个字体一个完整的可变字体文件能再少约 200 个，但 npm 包里没有完整文件，要从上游（Google Fonts 的仓库，OFL 许可）取一次放进仓库；界面打开时会整份加载（本地文件，约十几 MB 内存）。或者改用系统字体（微软雅黑、宋体），外观会变。字体几乎不改，按 sha256 去重以后更新时也不会重下。
- **把主进程代码打成一个文件**（rolldown，vite 8 已经带着）：app、host、notes、platform、relay-app 各打成一两个文件，hono、zod、ajv、MCP SDK 这些全内联。Studio 估计能到 300～400 个文件（大部分是 ui 和字体）。代价：开发和打包跑的不再是同一份代码，agent SDK 里 `createRequire` / `import.meta.url` 找文件的地方要单独处理（留成外部依赖），出错时堆栈要靠 source map。第一步之后如果还嫌多再考虑。
- **按包裁 CJS/ESM 双份**（剩约 430 个 cjs 文件）：要逐个包看谁 require、谁 import，容易漏，不建议；真要做不如走打包成一个文件。

## 要你定的

1. LICENSE 合并成一个 `THIRD-PARTY-LICENSES.txt`（建议），还是每个包的照留（多约 100 个文件）？
2. 真模型验证（上面第 5 条）你来点一遍再合并，可以吗？
3. 字体和「打成一个文件」这次都不做，可以吗？
