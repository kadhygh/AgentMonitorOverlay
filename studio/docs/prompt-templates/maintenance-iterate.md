# 维护迭代

（这是提示词模板「维护迭代」的原文，2026-10-31。存进 Studio：让任意会话照这个文件调 `prompt_template_save`，标题「维护迭代」，项目 AgentMonitorOverlay。改了这里要同步到模板。用法：人在当天的维护任务「MM-DD 维护」里开一个会话，用这个模板，后面接着写要改什么。维护节奏见 `studio/plans/release.md`。）

---

你在 AMO 的维护任务里，和人一起改一个问题。在主工作区 `G:\PROJECT\AgentMonitorOverlay` 里改，不开 worktree，不建分支。先读仓库根目录的 AGENTS.md（「怎么干活」里有这条车道的例外：验证通过就自己提交到 master）和 `studio/HANDOFF.md` 的「当前状态」。

1. 听人说清楚要改什么，不清楚就问。
2. 判断大小。新功能、有几种做法、改 protocol 或数据格式、跨几个工具、估计要动 5 个以上文件的，先跟人说清楚做法和范围，人同意了再动手。小的直接做。
3. 改。主工作区里可能有别的会话没提交的改动：
   - 只碰你要改的文件；
   - 提交时只 add 你改的文件（`git add <路径>`，不要 `git add -A` 或 `git add .`）；
   - 你要改的文件里已经有别人没提交的改动时，先问人。
4. 验证，重的任务都用 BelowNormal 优先级加 `--maxWorkers=6`：
   - `npm run typecheck`、相关的单测；
   - 改了界面就跑相关的 e2e 并截图，自己看一遍截图。
5. 验证通过：在改动的工具包的 `CHANGELOG.md`「下一版」一节写一条（给用户看的，具体、直白；工具和包见 `studio/scripts/amo-tools.mjs`），然后自己提交到 master，提交信息照最近几条的风格写。不用等人审。
6. 不要打包、不要发布：值守会在改动等够 30 分钟后自己发测试版。也不要 promote，不要部署中转服务，不要重启 Studio。改了中转服务（`packages/relay`、`packages/relay-ui`）的，在回复里提醒人要部署：`npm run release -- relay-service`。
7. 最后告诉人：改了什么、怎么验证的、提交号；有截图给路径。人接着说下一个问题时，从第 1 步再来。
