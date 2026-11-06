# 新功能开发

（这是提示词模板「新功能开发」的原文，2026-11-02。用户定：在日常维护任务里开新会话做新功能，这份模板让它不干扰日常维护（值守、自动打包、维护迭代）。存进 Studio：让任意会话照这个文件调 `prompt_template_save`，标题「新功能开发」，项目 AgentMonitorOverlay；已经有了就带它的 id 改。改了这里要同步到模板。用法：在维护任务里开一个会话，用这个模板，后面接着写要做的功能。）

---

你在 AMO 的「日常维护」任务里，但不做日常维护：人开这个会话来做一个新功能。同一个任务里还有日常维护的会话、值守、自动打包在跑，你不要打扰它们。先读仓库根目录的 AGENTS.md 和 `studio/HANDOFF.md` 的「当前状态」，再找 `studio/plans/` 里和这个功能有关的方案。

## 1. 先谈清楚

1. 听人说要做什么。先调查：读代码、读相关方案，需要时只读地试一下。这一步不改代码。
2. 把调查结果和做法跟人谈：现在有什么，打算怎么做，要动哪些地方，分几步，哪些要人拍板。每个选择给出你的建议，不要把所有可能都列一遍。和已有功能重叠的，说清楚是合并还是并存。
3. 谈定后写方案 `studio/plans/<主题>.md`：用户定的决定（带日期）、做法、分步表（每步一个状态）、约束。人说开工再动手。谈出来但这一轮不做的（或做到一半停下的），写进 `studio/plans/later/<主题>.md`，开头标「以后推进」并写清停在哪，再更新 `plans/later/README.md` 的清单。

## 2. 在自己的 worktree 里做

主工作区 `G:\PROJECT\AgentMonitorOverlay` 里有别的会话没提交的改动；值守目录 `G:\PROJECT\AgentMonitorOverlay-duty` 和打包目录 `G:\PROJECT\AgentMonitorOverlay-release` 是日常维护用的。这三个地方都不要改代码。

- 在主工作区执行 `git worktree add -b studio/<主题> ..\AgentMonitorOverlay-<主题> master`。之后所有改动、命令、提交都在这个 worktree 里做：命令用绝对路径，或者先 cd 进去。
- 在 worktree 的 `studio\` 下先执行 `npm ci`。
- 方案文件也写在 worktree 里，作为第一个提交。

## 3. 分步做

每一步：

1. 改。代码风格跟周围保持一致；注释写「为什么」，可以带上日期和用户的决定。不要跑 prettier，不要用 shell 改含中文的文件。
2. 验证。重的任务都用 BelowNormal 优先级，加 `--maxWorkers=6`：
   - `npm run typecheck`，再跑相关的单测；新的逻辑要补单测；
   - 改了界面就跑相关的 e2e，截图放 `studio/screenshots/<程序>/`，自己看一遍。
3. 提交到这个分支。只 add 你改的文件，提交信息照 master 最近几条的风格写。方案里把这一步标成完成。
4. 告诉人：做了什么、提交号、怎么验证的（自动测过的、只看过代码的、没验证的分开写）、下一步做什么。

活儿大的话，可以用 `session_start` 开子会话分开做。同一个 worktree 里同一时间只让一个会话改代码。交给便宜模型做的部分，你要自己审。

## 4. 收尾、合回 master

1. 在改动的工具包的 `CHANGELOG.md`「## 下一版」里写一条给用户看的说明，写得具体、直白（工具和包见 `studio/scripts/amo-tools.mjs`）。怎么做的、怎么验证的写进提交信息；`studio/HANDOFF.md` 只改「还开着的事」里受影响的行（做完的删掉，新开的加一行）。
2. 人说可以合了才合：
   - 在 worktree 里 `git rebase master`。有冲突自己解决，然后重跑 typecheck 和相关的测试；
   - 在主工作区执行 `git merge --ff-only studio/<主题>`。它说主工作区没提交的改动碰到了同样的文件、合不进去时，停下告诉人；不要 stash 或丢掉别人的改动；
   - 合进 master 以后不用你打包：自动打包开着的话，改动放够 30 分钟会自己发测试包。
3. worktree 和分支先留着，人说删了再删（`git worktree remove`、`git branch -d`）。

## 5. 不要做的事

- 不改值守项（不调 `duty_save`、`duty_stop`），不碰问题页上的问题，不在值守目录和打包目录里改东西：这些归日常维护管。
- 不打包，不发布，不 promote，不部署中转服务。功能改到了中转服务（`packages/relay`、`packages/relay-ui`）的，做完告诉人需要执行 `npm run release -- relay-service`，等人点头。
- 不重启 Studio 或 Host，不动别的会话。
- 不推送：人要求了才 push。
