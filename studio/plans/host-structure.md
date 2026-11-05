# Host 结构重排（2026-11-04 起）

> 状态：进行中。8a（2026-11-05 合进 master `fc6d7f10`，Studio 0.9.43）、8b 和 8c（2026-11-06 合进 master `10aed435`、`cc62e723`，Studio 0.9.45）做完；还剩：8c 留下的一组 feature 环没拆（`KNOWN_CYCLES`，见 8c），8b 留下的 19 处请求体 `as never`，8d 大文件拆分没开工。各块的「做到哪」、验证记录和逐条偏差 2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。

`plans/done/cleanup-2026-11.md` 的第 8 步。11-03 的审查结论：Host 都能跑，但最近两周一个接一个叠功能（远程会话、远程 Reviewer、中转进会话、值守、问题页、多账号），留下的是「下一个功能会更难加、更容易漏」的问题。每一块单独开 worktree 做，合并前用户点头；第 3 步（消息投递统一，`plans/done/message-delivery.md`）先合，它把 runtime 的公共部分提到了 `RuntimeBase`。

## 以后加 feature、路由要守的规则（8a–8c 定下的）

- **runtime 层不 import feature**：role card 和 MCP 工具靠回调注入。这一条从一开始就是干净的，保持。
- **路由**：`route("GET /api/xxx", handle, options?)`（`http/route.ts`），键必须是 protocol `HostRoutes` 里有的；`ctx.params` 按路径里的 `:名字` 有类型；handler 的返回值必须是声明的 `res`（声明为 `Blob` 的返回 `FileReply`），或者 `JsonReply`（自带状态码的回答）。**请求体是 `unknown`**：它来自外面，handler 用 `obj` / `str` 自己检查，类型上不假装它已经是 `req`。`untypedRoute(method, path, …)` 只给需要一条 `HostRoutes` 里没有的路由的测试用。
- **路由声明放在主题自己的 protocol 文件里**：有自己 protocol 文件的主题导出 `XxxRoutes`（`RemoteRoutes`、`DutyRoutes`、`McpRoutes`、`CanvasRoutes`……），`HostRoutes` `extends` 它们，`api.ts` 只留公共的（state、health、项目、设置、任务、会话等）。新功能在自己的 protocol 文件里加 `XxxRoutes` 并加进 `extends`，**不要再在 `api.ts` 末尾追加 `interface HostRoutes {…}`**。
- **远程副本能走哪些路由，写在路由旁边**：`RouteOptions.remoteCopy: "forward" | "local"`。`forward` = handler 会转给任务所在的电脑，`local` = 在这台电脑上做（比如批注）；两者在 HTTP 层一样放行，写出来是给下一个人看去向。没写就拒绝（`guardRoute`），所以加一条会话路由时漏了不会悄悄在本机执行。HTTP 层本身不转发：真正发到 A 的是 `RemoteRuntime`（消息、打断、审批、改名、归档）和 `TasksFeature`（新会话、任务改名、归档任务）。
- **远程副本是 Router 里的一个 runtime**：`features/remote/runtime.ts` 的 `RemoteRuntime` 注册成 `remote`（`RuntimeRouter.register`），会话的 `runtime === "remote"` 就走它；副本的模型 id（`remote:<设备>:<id>`）由 Router 按 `parseRemoteProfileId` 交给它。测试给 `HostService` 一个裸 runtime 时，用 `RuntimeRouter.around(store, runtime)` 包一层再注册。按会话判断是不是副本，用 `core/shared.ts` 的 `isRemoteCopy(session)`，不要再手写 `runtime === "remote"`。MCP 工具那层（`mcp/tools.ts` 的 `keepOffRemoteCopies`）另管，不是路由。
- **团队账号是 `core/teamlink.ts`（`TeamLink`）**：account.json / device.json 的读取和监视、`login()`、改设备名。remote、teamrelay、issues 都只依赖它（`this.teamLink`），teamrelay 不依赖远程开没开。`host-process` 的 `teamLink` 选项启动它和 teamRelay，`remote` 选项只管远程。`RemoteFeature` 听 teamLink 的 `account` / `device` 事件连接、改名；没人启动 teamLink 时（单测）`remote.start` 替它启动、`remote.stop` 再停掉，所以远程的单测照旧用 `remote.start({ env, protector, … })`，teamrelay、issues 的单测直接 `teamLink.start(...)`。
- **feature 声明它用到的 feature**（`core/feature.ts`）：`class DutyFeature extends Feature<"sessions" | "tasks">`，`this.f` 是 `Pick<HostService, D>`，`this.host` 是 `FeatureHost<D>`（Host 去掉所有 feature，再加上 `D`），用了没声明的编译不过。Host 自己的方法（`on`、`allProfiles`、`profileByRef`、`profiles`、`requireProfile`）走 `this.host`。feature 文件夹里不是 feature 的模块要用 Host 时收 `FeatureHost<…>`，**不要 import `HostService`**（API 文件 routes.ts / mcp.ts 除外，它们拿整个 Host）。新加 feature 要加进 `FeatureName`（`service.ts` 末尾有类型检查保证它和 HostService 的 feature 字段一一对应），HostService 上的 feature 字段写明类型（互相引用，推不出来）。
  - 为什么不是「构造时把用到的 feature 传进去」：feature 是 HostService 的字段，互相有环，构造 tasks 时 sessions 还没有。所以仍然传 Host，只是按声明收窄它的类型，效果一样。
- **依赖图由单测守着**：`src/features/feature-deps.test.ts` 从源码读每个文件夹的声明和对别的 feature 文件的值 import（`import type`、routes.ts / mcp.ts、测试不算；import 一个本身不碰任何 feature 的文件也不算，比如 `gitreview/git.ts`、`sessions/setups.ts`），得出按文件夹的依赖图，和其中的 `GRAPH` 对账：多了一条依赖、少了一条、声明了没用到、feature 文件 import `HostService` 都失败。**新的环不能加进 `KNOWN_CYCLES` 白名单**，要改成单向；白名单里的环拆开了，测试也会提醒更新。
- **几个 feature 都要用的判断放 `core/`**：`sessionMoving`、`isRemoteCopy`（`core/shared.ts`）；角色的判断和「上次告诉会话的角色」（`core/role.ts`，只要 store）。`guide/role.ts` 只留角色卡的文字，把 core 的再导出一遍。

## 8a 远程副本收成一个 runtime，团队连接独立出来（做完）

为什么先做：远程这条线改得最频繁，每加一个会话路由都要记得改白名单，最容易漏。审查时 `features/remote` 之外有约 40 处 `.remote` / `runtime === "remote"` 判断，拦截分四层（HTTP 层的路由字符串白名单 `COPY_ROUTES`、包在 Router 外的 `RemoteAwareRuntime`、MCP 工具外面一层、各 feature 自己写 if）；团队账号登录放在 `RemoteFeature` 里，teamrelay 和 issues 借 `this.f.remote.teamLogin()`，只有开了远程 teamRelay 才启动。

做成的样子见上面的规则（`TeamLink`、`RemoteRuntime`、`remoteCopy`、`isRemoteCopy`）。和原方案不同的地方：原方案想让 HTTP 层按元数据转发，核对后发现 HTTP 层本来只是放行，所以元数据只决定放不放行；`"deny"` 没做成一个值，没写就是拒绝（原来白名单外的也都拒，这次的收获是声明挪到路由旁边，不会漏改另一个文件）。按任务的 `task.remote` 是字段，还要读 `.remote.name`，没改成函数。

## 8b 路由有类型（做完，留一项）

为什么：原来 `route(method, path, handle)` 没有类型，请求体靠 `obj(body)` 手动解析，protocol 的 `HostRoutes` 都有声明但编译器不拦漂移；`api.ts` 一直在末尾追加；`codex-runtime.ts` 的 `as never` 是生成的 Codex 协议类型旧了（0.161.0 对本机 0.166.0）。

做成的样子见上面的规则。另外：

- Codex 协议类型用 `npm run gen:codex` 从本机装的 Codex 重新生成。生成的只是类型，Studio 照旧跑用户自己装的 Codex，版本旧的也一样。挡路的是 Host 自己的辅助函数类型写得宽：线程的 `config` 是 `CodexConfig`（`runtime/profiles.ts`，即 `ThreadStartParams["config"]`），turn 的输入是 `codex.v2.UserInput[]`，沙箱策略是 `codex.v2.SandboxPolicy`，`reviewTarget` 是 `codex.v2.ReviewTarget`。`rpc-client.ts` 的 `ResponseMap` 只列 Host 用的方法，几处响应用 `as unknown as` 取 Host 读的那几个字段，测试里的 `as never` 没动。
- 类型检查只说明「结构上兼容」：Host 多返回的字段 TypeScript 不拦（只有对象字面量才拦）。
- 问题页（issues）没有 Host 路由（只有 MCP 工具，HTTP 在中转服务上），所以没有 `IssuesRoutes`。
- 没做原方案的「新旧写法并存、一次一个 feature」：改写法只是把前两个参数合成一个键，一次改完，类型检查就是逐条核对。

**还没做**：请求体没有类型化（`Ctx<K>.body` 是 `unknown`）。各 feature 的 routes.ts 里还有 19 处 `obj(body) as never`（或 `(body ?? {}) as never`）把请求体直接交给 service（tasks、marks、topicdocs、taskplans、prompttemplates、gitreview 等），service 自己检查字段。要改成按 `RouteRequest<K>` 校验得动 service 的签名，原来留到 8c 之后。

## 8c feature 之间的依赖（做完声明和检查，环没拆完）

为什么：每个 feature 通过 `this.f` 拿到整个 HostService，谁都能调谁；tasks ↔ sessions、sessions ↔ collab 互相调；`sessionMoving` 写在 `tasks/service.ts` 却被 duty 和 http 引用；`guide/role` 被好几个 feature 引用。做法是先只做声明和检查（单测列出依赖图、禁止新增环），再逐步把公共判断挪到 `core/`，不追求一次拆干净。

做成的样子见上面的规则。核对时发现跨 feature 的路不止 `this.f`：远程的部件（grants、copies、views、uploads、requests、create、usage、comments）通过 context 拿整个 HostService，`guide/role.ts` 的函数收 HostService，`SessionInbox` 通过 `this.f.sessions` 调回它所在的 feature，`this.f` 上还用了 Host 自己的方法。这些都一起收了（远程 context 是 `FeatureHost<RemoteUses>`，`SessionInbox` 构造时直接拿 `SessionsFeature`），否则声明了也漏。

拆掉的：relays、sessions、taskplans 不再依赖 guide（角色判断挪进 `core/role.ts`）；config ⇄ claudeaccounts（账号变化时发 `settings.updated` 挪到 `ConfigFeature.watchClaudeAccounts()`，HostService 构造时调，仍在 microtask 里，时机不变）。issues 对 duty 只有 `import type`，接值守靠 `service.ts` 里的 `duty.registerCheck(issues.dutyCheck())`。当前的依赖图以 `feature-deps.test.ts` 的 `GRAPH` 为准。

**还没拆的环**（`KNOWN_CYCLES`）：一组 {collab、gitreview、projects、remote、review、sessions、tasks、viewpacks}。里面两两互相用的：tasks ⇄ sessions、sessions ⇄ collab、sessions ⇄ review、sessions ⇄ remote、tasks ⇄ remote、gitreview ⇄ remote、viewpacks ⇄ remote；projects 经 tasks → remote → gitreview → projects 进来（归档项目要归档任务；给一个文件夹打开 Review 会把它加成项目）。下一步可以拆的（都要改调用方式）：

- gitreview / viewpacks ⇄ remote：两边都只用 `remote.grants` 的「在这台还是配对的设备上打开」（`showsElsewhere` / `openRoute` / `pushOpen`），可以抽成一个 core 里的接口，由 remote 实现、在 `service.ts` 接上。
- sessions ⇄ review：`referencedAnnotations` 只读 store、写批注，挪进 core 或 sessions 后 review 只剩单向。
- sessions ⇄ collab：sessions 只在报告送不进收件箱时退回成留言（`collab.sendMail`），可以改成回调。
- tasks ⇄ sessions、tasks / sessions ⇄ remote 是主干（开会话、副本转发），等前面几条拆完再看。

## 8d 大文件（没开工）

- `dsh-runtime.ts`（2026-11-06 约 1300 行）：文件夹 ACL（`setupFolder` / `revertFolder` / `scanFolder` / `autoScan` / `fixFolderAccess` 和 kv `dsh-folder:`）、账号和 Key 的启动配置拆出去，照 Claude 已经拆出 live、asks、messages 的样子。
- `claude-runtime.ts`：多账号的 home 解析和切换挪进 `accounts.ts`；`homeOf` / `newHome` / `claude.login:` 三套「用哪个配置目录」的机制合成一处（注意 `ClaudeLogin = "token"` 是 API Key 渠道在用的，不是死代码）。
- 中转服务 `store.ts`（约 1200 行）和 `server.ts`：照 issues、todo、devices 已有的样子把 tasks、files、admin 拆出去；数据库加 `PRAGMA user_version` 顺序迁移，替掉每张表各自的 `PRAGMA table_info` + ALTER（部署会重启中转，先问用户）。

## 顺序

8d 碰到哪个文件拆哪个；`KNOWN_CYCLES` 按上面的几条一次拆一处。仍然是每块一个 worktree、一个分支，合并前用户点头。
