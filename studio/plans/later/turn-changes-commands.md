# 本轮改动：把命令改的文件也列进来

> 状态：以后推进（2026-11-06 用户定：先维持现状不动，记录一下，未来可能会优化）。谈了三种做法，没开工；下文的做法和数字是当时的建议和实测，用户还没选。

## 起因

2026-11-06，用户发现会话 `s-ea5c1e89…`（project_mining）回复里说「同目录有同名 .html 阅读版」，消息下面的改动文件列表里却没有这个 HTML。查下来：

- 「本轮改动」（`packages/ui/src/files/changes.ts` 的 `turnChanges`）只收这一轮完成了的编辑 / 写文件工具调用；diff 是 Host 拿工具调用里带的文字算的（`packages/host/src/runtime/claude/tool-use.ts` 的 `describeToolUse`），不读磁盘、不跑 git。
- 那一轮里 `.md` 是 Write 写的（列出了）；`.html` 是命令 `python Tools/HtmlKit/render_md.py …` 生成的，同目录 `README.md` 是命令 `python - <<'EOF'` 改的，都没列出。
- 同样会漏的：格式化工具、代码生成、`git checkout` / `git mv`、`npm install` 改的锁文件等一切命令改的文件。

## Codex 的做法（2026-11-06 读 openai/codex main 的源码）

- 每轮的 diff 由 `codex-rs/core/src/turn_diff_tracker.rs` 算，原话 "Tracks the net text diff for the current turn from committed apply_patch mutations, without rereading the workspace filesystem"：只记 `apply_patch`，命令改的文件同样不算。app-server 的 `turn/diff/updated` 只带一段合起来的 diff 文本。
- `codex-rs/git-utils/src/baseline.rs` 有「拿整个目录和自己的 git 快照比」的做法，但用在 Codex 内部目录上（看测试像是记忆功能），没用在用户项目上。
- 桌面版的审阅面板是不是 git 的全部改动：没查到（GitHub 代码搜索要登录），未验证。

## 谈过的三种做法

| 做法 | 怎么做 | 每轮开销（project_mining 实测，5.4 万个受跟踪文件，fsmonitor 开） | 问题 |
|---|---|---|---|
| 现状 | 只认编辑工具调用 | 几乎为零，和项目大小无关 | 命令改的全漏 |
| 两次 git status 比对 | 一轮开始、结束各一次 `git --no-optional-locks status --porcelain=v2 -z --untracked-files=all`；开始时给已改动的文件记指纹（大小 + 修改时间）、记 HEAD | 一次 619 到 688 ms，每轮一到两次，后台低优先级 | 只比 status 会漏：开始前就是 M、这轮又改的（要比指纹）；这轮里提交了的（要比 HEAD）；被忽略的文件永远看不到。分不清是谁改的（一整轮里你和别的会话的改动都会混进来） |
| 命令期间盯文件夹（推荐） | 会话一轮在跑时用 `fs.watch` 递归盯项目文件夹（Windows 系统通知，不扫描），同一文件夹几个会话共用一份；每条命令跑完，把它开始到结束（加 0.3 秒）之间变的文件记到这条命令上；去掉 `.git/`，对这几个文件问一次 `git check-ignore` 去掉被忽略的，编辑工具已列的不重复；标「命令改的」，点开看现在的内容，受跟踪的可看「和上次提交比」 | 开始盯 0.4 ms；盯 5 秒 CPU 约 0 ms，进程常驻内存约 36 MB（整个 node 进程）；新建的 .html 当场看到 | 命令那几秒里你或别的会话的改动也会算进来（可以排除同时间别的会话编辑工具改的）；项目文件夹外的不算；改太多的只列前 200 个；后台命令只记到它返回；给不出「只属于这条命令」的 diff（之前的内容没存） |

## 还没定的

- 选哪种做法（倾向第三种）。
- 「命令改的」在列表里怎么标、点开默认看什么。
- 被 `.gitignore` 忽略的文件要不要单独列（例如 `out/html/` 被忽略的项目）。
