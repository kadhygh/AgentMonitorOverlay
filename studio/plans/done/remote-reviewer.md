# 远程任务的 Reviewer：在控制端弹出、看、批注（2026-11-02，用户已定）

> 状态：做完（2026-11-02 在分支 `studio/remote-reviewer` 做完，合进 master，随 Studio 0.9.27 发布）。进度表和测试清单 2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。

## 起因

远程任务（`plans/done/remote-session.md`：A 是任务跑的电脑，B 经团队服务器控制它）里，agent 调 `view_open` / `review_open` 时，查看包或 Review 只在 A 上弹出；B 上什么也没有。B 对话里复制过来的工具行有「打开查看包」「打开 Review」，但它们拿 A 的 pack id 去问 B 自己的 Host，打不开。B 原来只能看对话里链接到的 HTML、Markdown、图片（`rt.file`），不能批注。

## 用户 11-02 定的

1. **在哪边弹**：谁发的消息引出了这一轮，就在谁那边弹；A 勾了「我也关心」时，B 发起的轮次两边都弹（后来改的，见下一节）。发起的那边不在线时（B 掉线了），在 A 上弹。两边对话里的「打开查看包」「打开 Review」都能用。
2. **B 的批注存在 B 上**，A 看不到，Reviewer 的批注不在两边共享。B 上的批注照常复制出去，路径写成「任务文件夹/…」；也可以「发到对话」，它走 `rt.send` 进 A 的会话，成为一条普通消息。
3. **范围**：查看包的三种条目（文件、Git 改动、改动预览）和 `review_open`（只有改动，没有查看包的那种）都做。

## 「我也关注」并进「我也关心」（用户 11-02 晚改）

原来打算单独加一个「我也关注」，两边各有一个勾。做出来后和已有的「我也关心」（问题 #8，`ALSO_MINE_KEY`）太像，合成一个：

- **A**：「已授权」横条上的「我也关心」一个勾管两件事：这个任务在 Focus 里照常提醒；B 发起的那一轮里 agent 打开的查看包和 Review，A 这边也弹。Host 在事件里带 `onlyIfAlsoMine: taskId`，A 的窗口读 `ALSO_MINE_KEY` 决定弹不弹。说明写在「我也关心」的悬停提示和授权对话框里。
- **B**：没有勾。只在自己发起的那一轮弹；A 发起的不推给 B（对话里的「打开查看包」「打开 Review」照样能打开）。
- 只存在本机，不经服务器同步；默认不勾。

## 做法

### 1. A 把「打开」告诉 B

- A 处理 `rt.send` 时，记下这个会话这一轮是哪台设备发起的（只记在内存里：轮次结束前有效，Host 重启后按 A 本机处理；委派会话看父会话）。A 本机发的消息算 A 发起的。代码在 `host/src/features/remote/grants.ts` 的 `turnOf`。
- 被授权任务的会话里有了 `viewpack.open` / `review.open` 时：
  - 发起的是 B，且 B 在线：经服务器推一条 `open` 给 B（带 taskId、sessionId、packId，或者 Review 的目标）。A 自己只在勾了「我也关心」时才弹。
  - 发起的是 A：照常在 A 上弹，不推给 B。
  - 只推任务自己项目的 pack 和 Review。
- `view_open` / `review_open` 在 A 的窗口没开时会报错（`viewpacks/service.ts` `open`、`gitreview/service.ts` `openReview` 的 `liveWindows`）；要推给在线的 B 时不报这个错。

### 2. B 经 A 读查看包的内容（`rt.view`）

- B 上 Reviewer 读数据都是 `call(link, "GET /api/…")`，一共十来个：`/api/viewpacks/:id`、`…/items/:itemId/diff`，`/api/workspaces/:id/git/{status,changes,diff,commit,commit-diff,log}`，`POST /api/fs/exists`，还有读文件。远程 pack 的窗口换一个 link（经 B 自己的 Host `/api/remote/view/<task>/…`，`ui/src/remote/reviewer.tsx`），这些请求由 B 的 Host 用 `rt.view` 转给 A，界面组件基本不改。A 这边的回答在 `host/src/features/remote/views.ts`（`answerView`，大的分块回）。
- A 上的检查要严：
  - pack 必须是这个被授权任务里某个会话的；Review 的目标必须是这个任务的项目文件夹；
  - git 只在任务文件夹里跑，只读；单个文件的 diff 只给同一个范围的改动列表里有的文件、或查看包点名的文件，提交的 diff 只给这个提交改了的文件，`untracked` 由 A 按列表定（审阅 11-02：不然带 `untracked=1` 能整个读走被 gitignore 的 `.env`，没改动的文件 diff 出来也是整个文件）；历史最多 `GIT_LOG_MAX` 条；
  - 文件不能出任务文件夹（和 `files.ts` 一样先解析链接和 junction），有大小上限；
  - 文件条目放开到文本和代码文件，但只限查看包里点名的文件，以及 diff 里出现的文件。普通的 `rt.file` 范围不变。
- 结果按 `RemoteFiles` 的做法存在 B 的数据目录（`remote-views/<task>/`），A 离线时显示上一次取到的，并说明是旧的。
- B 对话里的「打开查看包」「打开 Review」在远程副本上走这条路。
- 中转服务不用改：它转发任何合规的 kind。

### 3. B 上的批注

- 批注由 B 的 Host 自己回（`host/src/features/remote/comments.ts`），按任务存在 kv 里，归档副本时删掉；A 上没有。
- 复制出来的文字写「任务文件夹/<路径>」、项目写「<A> 上的任务文件夹」，不写 A 的绝对路径（路径里带用户名）。
- 「发到对话」：只发进这个任务自己的对话，走 `rt.send`，路径照会话读的写（相对任务文件夹）。
- 查看包、远程 Review 和对话里链接打开的远程文件都能批注，只有对话附件不能。
