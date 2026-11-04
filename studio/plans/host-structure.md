# Host 结构重排（方案，2026-11-04）

`plans/cleanup-2026-11.md` 的第 8 步。11-03 的审查结论：Host 现在都能跑，但最近两周一个接一个叠功能（远程会话、远程 Reviewer、中转进会话、值守、问题页、多账号），留下的是「下一个功能会更难加、更容易漏」的问题。这份只写方案，没动代码；每一块单独开 worktree 做，合并前用户点头。**第 3 步（消息投递统一，`plans/message-delivery.md`）先合**，它会把 runtime 的公共部分提到 `RuntimeBase`，下面几块都建立在它之上。

## 现在的样子

- `bin.ts` → `host-process.ts` 组装 Store、ChannelRegistry、三个 runtime（Codex、Claude、DSH）、`RuntimeRouter`，再建 `HostService`（`service.ts`）和 HTTP / MCP 服务器。
- `HostService` 持有约 37 个 feature（`features/<名字>/service.ts`）。每个 feature 通过 `this.f` 拿到整个 HostService（`core/feature.ts`），谁都能调谁。
- `features/index.ts` 汇总各 feature 的 `routes.ts` 和 `mcp.ts`。
- runtime 层不 import feature（靠回调注入 role card 和 MCP 工具）——这一条是干净的，保持。
- 远程：`RemoteAwareRuntime`（`features/remote/runtime.ts`）包在 Router 外面处理「远程副本」会话。
- 存储：SQLite，23 个迁移（最后一个 10-29），之后的新功能基本都进了 `kv` 表。

## 8a 远程副本收成一个 runtime，团队连接独立出来（先做这块）

为什么先做：远程这条线最近改得最频繁，每加一个会话路由都要记得改白名单，最容易漏。

现状（审查时数的）：`features/remote` 之外有约 40 处 `.remote` / `runtime === "remote"` 判断，拦截分四层——HTTP 层按路由字符串白名单（`remote/service.ts` 的 `COPY_ROUTES`）、`RemoteAwareRuntime` 包在 Router 外（不是注册进 Router 的第 4 个 runtime）、MCP 工具外面再包一层（`mcp/tools.ts`）、各 feature 自己写 if（tasks、teamrelay、mcp/read-model、http/server）。团队账号登录（account.json、device、DeviceLink）放在 `RemoteFeature` 里，teamrelay 和 issues 借 `this.f.remote.teamLogin()`；只有传了 `options.remote` 时 `teamRelay.start()` 才跑（`host-process.ts`）。

做法：
1. 拆出 `core/teamlink`：账号、设备号、和团队服务器的连接。remote、teamrelay、issues 都只依赖它；teamrelay 不再依赖远程是否开着。
2. `RemoteAwareRuntime` 改成 Router 里注册的 `remote` runtime：会话的 `runtime === "remote"` 就走它，外面不再包一层。
3. 路由声明时带元数据（例如 `route(..., { remoteCopy: "forward" | "local" | "deny" })`），HTTP 层按元数据转发，删掉 `COPY_ROUTES` 白名单；一条没声明的会话路由默认 `deny`，比现在漏写时悄悄在本机执行安全。
4. 各 feature 里的 `.remote` 判断能用 3 解决的去掉，剩下的集中成 `isRemoteCopy(session)` 一个函数。

验证：现有 remote 单测和 e2e（`remote*`、`remote-reviewer`、`remote-files`、`remote-tasks`）全过；新加一条：一条没声明 `remoteCopy` 的新路由对远程副本返回明确的错误。

## 8b 路由有类型

现状：`route(method, path, handle: (ctx) => unknown)` 没有类型（`http/route.ts`），请求体靠 `obj(body)` 手动解析。审查时对过：Host 的 196 条路由 protocol 的 `HostRoutes` 都有声明，但编译器不拦漂移；UI 的 `call()` 有类型，Host 这边没有。`api.ts` 一直在末尾追加（remote、duty 已经有自己的 protocol 文件，路由还写在 `api.ts`）。`codex-runtime.ts` 有 19 处 `as never`。

做法：
1. `route<K extends keyof HostRoutes>(key, handle: (ctx: Ctx<K>) => Res<K> | Promise<Res<K>>)`，一次改一个 feature，旧写法和新写法并存到改完。
2. 各主题导出自己的 `XxxRoutes`（remote、duty、issues、mcp……），`HostRoutes` `extends` 它们，`api.ts` 只留公共的。
3. 重新生成 Codex 的协议类型，去掉 `as never`（先确认是不是生成的类型旧了）。

## 8c feature 之间的依赖

现状：tasks ↔ sessions、sessions ↔ collab 互相调；`sessionMoving` 写在 `tasks/service.ts` 却被 duty 和 http 引用；`guide/role` 被 5 个 feature 引用。

做法：每个 feature 声明它用到哪些 feature（构造时传进去，而不是拿整个 `this.f`），先只做声明和检查（一个单测列出依赖图、禁止新增环），再逐步把公共判断（`sessionMoving`、role）挪到 `core/`。不追求一次拆干净。

## 8d 大文件

- `dsh-runtime.ts`（约 1050 行）：文件夹 ACL（`setupFolder` / `revertFolder` / `scanFolder` / `autoScan` / `fixFolderAccess` 和 kv `dsh-folder:`）、账号和 Key 的启动配置拆出去，照 Claude 已经拆出 live、asks、messages 的样子。
- `claude-runtime.ts`：多账号的 home 解析和切换挪进 `accounts.ts`；`homeOf` / `newHome` / `claude.login:` 三套「用哪个配置目录」的机制合成一处（注意 `ClaudeLogin = "token"` 是 API Key 渠道在用的，不是死代码）。
- 中转服务 `store.ts`（约 1180 行）和 `server.ts`（约 60 条路由）：照 issues、todo、devices 已有的样子把 tasks、files、admin 拆出去；数据库加 `PRAGMA user_version` 顺序迁移，替掉每张表各自的 `PRAGMA table_info` + ALTER（部署会重启中转，先问用户）。

## 顺序

第 3 步合并 → 8a → 8b（可以和 8c 并行）→ 8d 碰到哪个文件拆哪个。每块一个 worktree、一个分支，合并前用户点头。
