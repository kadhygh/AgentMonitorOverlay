# 开始维护

（这是提示词模板「开始维护」的原文，2026-10-31；11-01：值守项改名「日常值守」，测试包由挂在它下面的「自动打包」发，不再开会话。存进 Studio：让任意会话照这个文件调 `prompt_template_save`，标题「开始维护」，项目 AgentMonitorOverlay。改了这里要同步到模板。维护节奏见 `studio/plans/release.md`「维护节奏」。用法：每天新建任务「MM-DD 维护」，在它的第一个会话里用这个模板。）

---

你在今天的 AMO 维护任务里。照下面把今天的值守设好，然后结束。别的什么都不改。

## 1. 值守目录

值守目录是 `G:\PROJECT\AgentMonitorOverlay-duty`：master 的一份干净副本（detached worktree），值守在那里修问题，不碰主工作区。打包目录是 `G:\PROJECT\AgentMonitorOverlay-release`：另一份 master 的干净副本，只给自动打包用，没人在里面改东西。

- 不存在：在主工作区 `G:\PROJECT\AgentMonitorOverlay` 里执行 `git worktree add --detach ..\AgentMonitorOverlay-duty master`（打包目录同样：`..\AgentMonitorOverlay-release`）。
- 两个目录的 `studio\` 下各执行一次 `npm run release -- sync`：同步到 master 最新，依赖变了才重装（第一次要装依赖，几分钟）。
- 它说「有没提交的改动」或「还有提交没进 master」时停下，把输出告诉人。不要丢掉、不要强行覆盖。

## 2. 两个前提

- 用 `project_context` 找路径是值守目录的项目。没有就停下，请人在 Studio 左栏「+ 添加项目」加上 `G:\PROJECT\AgentMonitorOverlay-duty`（名字随意），加好了再接着做。
- 用 `prompt_template_list` 确认有「问题页值守」这份模板。没有就停下告诉人。

## 3. 值守项

两项，保存各要人批准一次。用 `duty_list` 找：有就用 `duty_save` 带它的 id 改，没有就新建。

**日常值守**（标题是「日常值守」或旧名「AMO 维护」的那项）：

```
title: "日常值守"
schedule: {"every": 60}
action: {
  "kind": "session",
  "prompt": "照提示词模板「问题页值守」做：用 prompt_template_list 找到它，读全文，一步一步照做。",
  "workspace": "G:\\PROJECT\\AgentMonitorOverlay-duty",
  "check": {"kind": "builtin", "name": "issues.pending"}
}
```

- 不写 taskId：默认就是这个任务，值守开的会话都在这里。
- 不写 model 和 permission：默认用你的模型和你的权限。值守会话没人看着，权限是「逐条询问」的话它会一直停在审批上。你自己是逐条询问时，先告诉人，建议这个任务用「帮我审批」或更宽的权限重开一个会话再设。
- 每分钟先检查一次问题页，有事才开会话：有新问题、人回复了、上一次打测试包没成功。上一个会话还在跑时不会再开。

**自动打包**（挂在日常值守下面，parentId 写日常值守的 id）：

```
title: "自动打包"
schedule: {"every": 60}
parentId: "<日常值守的 id>"
action: {
  "kind": "command",
  "command": "node G:/PROJECT/AgentMonitorOverlay-release/studio/scripts/release.mjs auto --if-due",
  "timeoutSec": 3600
}
```

- 不开模型。每分钟看一次：哪个工具写了「下一版」、最后一次改动后 30 分钟没有新改动（或最早的改动已经等了 2 小时），或者人在问题页点了「发布打包」，就在打包目录里跑测试、升版本、打包、发到测试通道，把这次修好的问题标成已发布。没事时什么都不输出。
- 失败了，问题页的打包进度会写停在哪；日常值守的检查看到后开会话去查。同一个 master 上它不会自己再试。
- 日常值守关掉时它也跟着关。

## 4. 结束

回一小段话：两个值守项开着没有、多久检查一次、会话开在哪个任务、在哪个文件夹里干活；值守目录和打包目录在 master 的哪个提交。人可以在顶栏「值守」里看它，问题页上看「要你看」。
