# AMO 中转 · 2026-11-05 这一轮调整

> 状态：四件都做完了，在分支 `studio/relay-round-1105` 上（第 1 件 `33b308c6`，服务和 Studio、外壳 `227c5510`，界面和 e2e 是之后那个提交），**没合进 master、没部署、没发布**。按用户定的「全做完再一起发」：合进 master 后中转服务（`npm run release -- relay-service`）、中转外壳、Studio 一起发。用户原话见文末。
>
> 做法上和方案的出入：「已接手」时 Studio 里那条显示一天后自己消失（`TAKEN_SHOWN_MS`）；刚登录时列表和实时连接之间来的会话会丢（e2e 撞到的老问题），顺手修了（`relay-ui/src/session.ts`：先连再拉列表，拉的过程中收到的会话保留）。

## 用户的决定（2026-11-05）

- Q1–Q7 都按推荐：查看器改成拖得动的面板 + 直接引用 Reviewer 的 FloatBox；做 J1+J2+J3，J1 用 Host 的打开接口；已接手 = 结束会话，附言可以不写；说明页 + 状态旁的「?」。
- **已接手不默认告诉发起的 AI**（批注 1）：大多数会话是 AI 某一轮做完发出去的，比如做完了请程序审，程序看了觉得够了就直接接受——这时发起的会话完全不需要再收一条消息。所以：
  - 已接手只改状态：Studio 里「等 X 回复」变成「X 已接手」，会话不收消息、不再跑一轮；
  - 收件人点「已接手」时有一个勾选「把附言转给发起的 AI（它会再跑一轮）」，默认不勾；只有勾了才送进去（Studio 的会话、`relay inbox` / `relay_inbox` 都一样）。
- **Q8 全做完再一起发**（批注 2）：中转服务、中转外壳、Studio 一起发，不分批。

## 先说发布：每块改动分别走哪条路

| 改的地方 | 怎么到用户手里 |
|---|---|
| `relay-ui`（客户端界面） | 部署中转服务（`npm run release -- relay-service`）后，所有客户端自动热更新 |
| `relay`（服务端：数据、状态） | 同上，部署中转服务 |
| `relay-app`（外壳：开窗口、启动别的程序、读本机文件） | 平台发布中转（`npm run release -- relay`），用户在平台里更新 |
| Studio（`app`、`host`、`ui`） | 平台发布 Studio |

所以：只改 `relay-ui` 的方案最快、最便宜；要动外壳的，得等用户更新外壳，界面要对旧外壳做退路。

---

## 1. 复制给 AI 不带批注（已修）

**原因**：`SessionView.tsx` 的「复制给 AI」只调用 `threadAsText(thread, messages)`，也就是只拼消息。批注存在文件上（服务端 `notes` 表），只有回复时勾了「附上我的批注」，才会被抄一份进那条回复（`Message.notes`）。所以下面这些批注都复制不进去：发起人自己写的；回复之前、回复之后写的；回复时没勾选的。

**改法**（`33b308c6`）：
- 复制时取会话附件上的全部批注（所有版本）和文件原文。回复里没带的批注，放到「## 附件上的批注」里。「复制新回复」只带你上次发言之后写的批注。
- 每条批注的写法和 Reviewer 复制的一样：`文件名:行号`，下一行 `>` 后面是引用的原文，再下一行是批注内容（作者）。
- 行号由 `packages/relay/src/usage.ts` 的 `noteLine` 算。批注只存了引文和前后各 24 个字，所以在原文里按显示的样子去找：先原样找，再去掉 Markdown 记号和 HTML 标签找，最后找引文里最长的一段。找不到时只写文件名。
- 回复里带的批注，复制的人有原文时也带行号。`relay file`、`relay_file_get` 和查看器的「复制批注」也用这个写法。

**验证**：`tsc -b`；relay-ui 类型检查；vitest（relay 和 host teamrelay，共 87 个）；e2e relay 7 个全过，新加了两处检查：程序回复前复制，带上自己的批注和 `designdoc.md:3`；策划复制，回复带的批注有行号，而且不重复。

---

## 2. 中转里的审核（查看器）

### 现状
- 中转用的是**自己的查看器**，没有嵌 Reviewer：`packages/relay-ui/src/Files.tsx` 的 `FileViewer`。
- 它是一个模态弹窗（`Dialog.tsx:17`，`.overlay` 盖住整个窗口，点外面就关）。所以会挡住后面的会话内容，也拖不动。
- 批注写在右边固定的「批注」栏里（`Files.tsx` 的 `.note.new` 文本框），不是 Reviewer 那种跟着选区、能拖动的小窗。
- 批注存在中转服务器上，按引文和前后文定位（`anchors.ts`）。对方能看到，回复时能附上，AI 用 `relay_file_get` 能读到。
- Reviewer 那个能拖的小窗是 `packages/ui/src/review/FloatBox.tsx`，117 行，纯 React，不依赖 Host。Reviewer、Studio 的 diff 和对话批注都在用它。样式在 `review.css:39-47`，用的是 Studio 的主题变量。
- 外壳 `relay-app` 只有一个窗口：`main.ts:129` 唯一的 `new BrowserWindow`；`setWindowOpenHandler` 会拒绝开新窗口。外壳不读 `programs.json`，也不会启动别的程序。

### 改法

**A.（推荐）只改界面：查看器变成可以拖动的面板，批注用 Reviewer 的小窗**
- 查看器不再是模态弹窗：去掉遮罩，能拖标题栏、拖角改大小；后面的会话还能看、能点；有按钮「铺满」或「靠右半边」。
- 选中文字后点「写批注」，弹出 FloatBox 小窗，就在选区旁边，能拖、能改大小。Ctrl+Enter 保存，Esc 取消，和 Reviewer 一样。批注列表还留在右边栏。
- FloatBox 直接用相对路径引用 `packages/ui/src/review/FloatBox.tsx`，不复制一份。relay-ui 已经用这种方式引用 `relay/src` 的代码，Vite 会打包进去。样式抄 `.float-note*` 那几条，把主题变量对到中转的颜色。
- 代价：只改 relay-ui，部署中转服务就生效，不用发外壳。缺点是查看器仍在中转窗口里面，拖不出窗口。

**B. 外壳开一个独立窗口看文件**
- 外壳加一个 `openViewer(fileId)`，开第二个系统窗口，可以拖到别的屏幕；里面再用 A 的批注小窗。
- 代价：要改外壳（`SHELL_VERSION` 加 1、窗口控制改成按发起的窗口算、第二个窗口要重新登录），用户要在平台里更新中转；旧外壳退回 A。工作量大约是 A 的两倍。

**C. 装了 Reviewer 时在 Reviewer 里打开**
- 符合「只有一份 Reviewer」：从 `programs.json` 找到 `tools.reviewer`，或者找 Studio 的 Host，把文件下载到临时文件夹，再用 `--mode file --file` 打开。
- 代价大，而且有实际问题：
  - 批注会记进 Reviewer 本机的数据库，不在中转服务器上，对方看不到，回复时也附不上；要接回中转，得给 Host 加一套转发批注的接口（类似远程任务的 `remote/comments.ts`）。
  - 只装了 Studio 时没有 Reviewer 的 exe，要另外去找 Studio 的 Host。
  - 要改外壳。
- 建议这一轮不做。最多以后加一个「在 Reviewer 里看（不批注）」。

---

## 3. Studio 开着时的跳转

### 现状（手段）
- **会话是谁发的**：Studio 发出的每条消息带 `Via {kind:"ai", client:"AMO Studio", conv:"studio:<设备号>:<Studio 会话 id>"}`（`host/src/features/teamrelay/service.ts:45`），服务端把最新的标记记在 `thread.request.conv`。设备号来自 `%APPDATA%\AMO\device.json`，本机各工具共用。所以中转客户端能认出「这条会话是本机哪个 Studio 会话发的」。没有 taskId，要问 Host 才知道（会话所属的任务）。
- **Studio 开着没有**：Studio 在数据目录写 `shell.json {pid, exe}`、`host.json {url, port}` 和 `host-token`；数据目录从 `%APPDATA%\AMO\platform.json` 的 `studioDataDir` 来（平台装的）。平台就是这样判断的（`platform/src/running.ts`）。
- **从外面让 Studio 跳过去**：现在**没有办法**。没有自定义协议；`second-instance`（`app/src/main.ts:341`）只处理 `--amo-quit`；Host 也没有「打开某个任务或会话」的接口。Studio 内部跳转走 IPC `amo:navigate`（Focus 的「在工作台打开」、便签待办都用它）。
- **从外面让中转打开某条会话**：也没有办法。外壳的 `second-instance`（`relay-app/src/main.ts:716`）只是把窗口提到前面。内部已经有现成的口子：通知点击 → `relay:open-thread` → 界面 `onOpenThread`。
- Studio 不找中转客户端：不读 `programs.json` 的 `tools.relay`，也不读中转的 `running.json`。

### 值得加的跳转

| # | 从 | 到 | 谁用 | 推荐 |
|---|---|---|---|---|
| J1 | 中转里一条 AI 发的会话（我是发起人，而且是本机 Studio 发的） | Studio 里发起它的那个会话（所在任务） | 策划 | 做 |
| J2 | Studio 任务页、Focus 里的「等 X 回复（中转）」 | 中转里这条会话 | 策划 | 做 |
| J3 | Studio 里已经发出的 team_ask 卡片 | 中转里这条会话 | 策划 | 和 J2 一起做 |
| J4 | 中转里别人发来的会话（我是收件人） | 在 Studio 里新建一个任务处理它（带上会话内容和附件） | 程序 | 以后再说：要 Host 新建任务的接口，范围大 |

J1 只对发起人的本机有效：收件人的机器上没有那个 Studio 会话。按钮只在 `conv` 的设备号等于本机设备号、而且 Studio 开着时显示。

### 实现方式

**J1（中转 → Studio），推荐：Host 加一个「打开」接口**
- Host 加 `POST /api/ui/open {sessionId}`（要 token），发一个事件，Studio 主进程收到后走现有的 `amo:navigate`，再把窗口提到前面。
- 中转外壳读 `device.json`（判断是不是本机发的），再读 Studio 的 `host.json`、`host-token`，调这个接口。界面内容不直接碰 token。
- 代价：Studio 改 Host 和主进程，要发 Studio；外壳加一个 `openInStudio(conv)`（可选方法，旧外壳没有就不显示按钮），要发中转外壳。
- 和约束的关系：这是工具之间直接调用，便签和 Studio 之间已经有先例（Studio 调便签的本机接口，`app/src/notes-link.ts`）；不经过平台，也不改平台。
- 另外两种做法：
  - 用 `shell.json` 里的 exe 加启动参数 `--amo-open-session <id>`，靠 `second-instance` 接。缺点：开发版的 exe 是 electron.exe，光靠它启动不了 Studio；Studio 没开时会把它启动起来，而用户说的是「Studio 开着时」。
  - 注册 `amo-studio://` 协议。缺点：要写注册表，便携版、平台版、开发版会互相抢。

**J2/J3（Studio → 中转），推荐：中转外壳认一个启动参数**
- 外壳在 `second-instance` 和第一次启动时认 `--open-thread <id>`，走现有的 `onOpenThread`。Studio 主进程从 `programs.json` 的 `tools.relay` 找到 exe（或者读中转的 `running.json`），用这个参数启动它：中转开着就跳过去，没开就打开并跳过去。
- 代价：外壳改几行；Studio 主进程加一个 `openInRelay(threadId)`；界面在 `TeamRelay.tsx` 的横幅和卡片上加「在中转里打开」。没装中转（`programs.json` 里没有）时不显示按钮。

---

## 4. 「已接手」和方案说明

### 现状
- 会话三个状态：`open`（在收件人手里）、`returned`（回到发起人手里）、`done`（`store.ts:744` 的 `sessionAction`）。
- AI 发来的会话都是 `needsReply`：收件人**不能**标记完成，只能回复（`store.ts:757`）。所以「不用回、我来做」的情况，现在只能随便回一句。
- 已经有几个名字相近的按钮，要分清：
  - 「接手任务…」：把团队任务流转给自己，收紧后的界面里看不到；
  - 「我来处理」：发起人从自己的 AI 手里接过来。
  - 新按钮要避开这两个，建议叫 **「已接手，不用回复」**，状态写「X 已接手」。
- Studio 那边（`teamrelay/service.ts` 的 `scanOnce`）只把 `returned` 的回复转回会话；`done` 只记下来，不告诉会话。所以对方「已接手」后，Studio 里的 AI 会一直「等 X 回复」。

### 改法（推荐：已接手 = 结束会话，并告诉发起方）
- **服务端**：
  - 加一个动作 `take`：只有收件人能做，会话在收件人手里时才能用，`needsReply` 的也能用。
  - 可以带一句附言（比如「我来改，改完在群里说」）。
  - 效果：会话变成 `done`，另外记 `takenBy`、`takenAt`；写一条事件消息「已接手：附言」。
  - 旧客户端、旧命令行只认得 `done`，会显示「已完成」，不会出错。
  - 任何一方都能「重新打开」（现有的）。
- **发起人是人**：列表和会话头上的标签写「X 已接手」，不写「已完成」，附言显示在消息里。
- **发起人是 AI**：
  - Studio 的 `scanOnce` 看到新的「已接手」，往发起的会话里送一条：「【中转】X 已接手『标题』，不会逐条回复。附言：……。不用再等，这件事由 X 去做；你这边按情况收尾，或者接着做别的。」只送一次（`TeamThread` 记下已送达）。
  - 命令行 `relay inbox` 和 MCP 的 `relay_inbox` 也把「已接手」当成一条新消息给出来。
- **界面**：
  - 收件人的回复表单和「用话回答」那一栏都加按钮「已接手，不用回复」，点了弹一个小框写附言（可以不写）。
  - 发起人那边「已接手」的会话不进「待我处理」。

另一种做法（不推荐）：已接手后会话**不结束**，变成新状态「已接手 · 处理中」，留在收件人手里，做完再点「处理完了」通知发起人。这样多一个状态、两个动作，旧客户端不认识这个状态，AI 也要等两次。

### 方案说明放哪、写什么
- **推荐**：
  - 左下角（`SideFoot`）加一个「说明」，打开一页「中转怎么用」，内容是 relay-ui 里的一份 Markdown，跟界面一起热更新；
  - 会话头上的状态标签旁边放一个小「?」，点了直接跳到说明里这个状态那一节。
- **写什么**（短句、一行一条）：
  1. **会话是什么**：谁发给谁、发起人的 AI 怎么接着做。
  2. **状态**：等你处理、等对方处理、回复已到·复制给 AI、AI 已取回·处理中、可能卡住了、X 已接手、已完成。每个写清是什么意思、该谁动。
  3. **按钮**：回复并返回、已接手不用回复、标记完成（谁能点）、撤回并标记完成、我来处理、交还给 AI、再回复一次、继续追问；复制给 AI、复制新回复、复制取回指令，三个各用在什么时候。
  4. **规则**：AI 发来的会话为什么必须回复或接手；批注怎么写，怎么附上，复制时会带上。
  5. **和 Studio 一起用**：Studio 发的会话，回复会自己回到那个会话；做了 J1、J2 后，写怎么跳。

---

## 要用户定的问题

| # | 问题 | 选项 | 推荐 |
|---|---|---|---|
| Q1 | 查看器怎么改 | A 只改界面：拖得动的面板，加 Reviewer 的批注小窗 / B 外壳开独立窗口 / C 在 Reviewer 里打开 | **A**，B 以后需要再加，C 不做 |
| Q2 | 批注小窗的代码 | 直接引用 `ui/src/review/FloatBox.tsx` / 复制一份到 relay-ui | **直接引用**（只有一份，改了两边一起变） |
| Q3 | 这一轮做哪些跳转 | J1+J2+J3 / 只做 J2+J3（不用改 Host）/ 加上 J4 | **J1+J2+J3** |
| Q4 | 中转怎么让 Studio 跳过去（J1） | Host 加打开接口 / Studio 启动参数 / `amo-studio://` 协议 | **Host 加打开接口** |
| Q5 | 「已接手」之后会话 | 结束（标「X 已接手」），能重新打开 / 不结束，等「处理完了」 | **结束** |
| Q6 | 「已接手」时写附言 | 可以不写 / 一定要写一句 | **可以不写** |
| Q7 | 方案说明 | 左下角「说明」页 + 状态旁「?」 / 只有说明页 / 只在按钮上加悬停提示 | **说明页 + 「?」** |
| Q8 | 发布顺序 | 界面和服务一起（部署中转服务）先上，外壳和 Studio 跟着各自发版 / 全做完一起发 | **分开**：A、已接手、说明页先上；跳转等外壳和 Studio 发版 |

## 用户原话

> 中转的功能需要调整一轮。如果studio开着应该加一些功能跳转。然后我们增加一些方案的说明。比如有的信息，其实不需要我回复。这时候收信息方可以标为已接手
>
> 中转里审核用的是reviewer吗？感觉首先他会遮挡后面的内容，窗口也无法拖拽，然后标记批注也不是用的reviewer里的可以四处拖动的编辑窗口。
>
> 中转对话，我点击复制给ai，里面没有带着我的批注一起复制
