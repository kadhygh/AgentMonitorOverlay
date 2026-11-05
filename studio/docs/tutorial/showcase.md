# AMO 展示

<!-- 展示页（npm run tutorial:build 生成 out/html/showcase.html）。每屏：## 标题（10 个字以内）{#id}，下一行副标题
     （20 个字以内），::scene 放动画（showcase/*.js），::more 是右下角「怎么用 →」链到的教程章节。
     ::intro：这一屏是开场，标题和副标题在动画里出现，页面上只留给读屏软件；::kicker 是标题上面的小字；
     「! 」开头的行是标题下面的提醒（远程的安全）。最后一屏「快速开始」用 ::card 标题 + 1. 2. 3. 写步骤卡
     （卡后面的 ::more 是这张卡的「详细步骤 →」），::cta 加按钮列表。
     11-05 用户：去掉「从装平台开始」，换成快速开始：会用 AI 的从源码跑 Studio；想试远程，在电脑上开服务、手机装 APK。
     更复杂的部署不写，用得明白的人自己会研究。
     2026-10-30 用户定的结构：① 开场（多 AI、Focus、额度）② 专题 › 任务 › 会话 + 画布 ③ 工具：Reviewer + 便签（都和审阅有关）
     ④ 测试中：中转 + 远程，强调远程的安全。每屏的动画分几章，每章下面链到教程里讲它的那一节（showcase/*.js 的 chapters）。 -->

## 所有 AI，一个工作台 {#hero}
Claude、Codex、DeepSeek，第三方 API 也能接
::intro
::scene sc-intro

## 专题 › 任务 › 会话 {#topic}
项目只管在哪，任务才是干活的单位
::scene sc-topic

## 审 AI 的活，又快又准 {#review}
::kicker 工具 · 不装 Studio 也能单独用
AI 标出要看的几处，便签边看边记
::scene sc-tools

## 跨人、跨设备接着干 {#remote}
::kicker 测试中
中转找人确认；远程换台电脑或手机接着用
! 只在局域网里用，只配对你自己的设备
! 远程会话的命令以这台电脑上你的身份运行
! 别的账号建的任务默认先等你同意；授权随时能收回
::scene sc-cross

## 快速开始 {#start}
会用 AI 编程的，从源码跑起来最快
::card 从 Studio 开始
1. 装好 Node 24 LTS 和 Git；Claude Code 或 Codex 在本机登录过
2. 克隆仓库 `github.com/kadhygh/AgentMonitorOverlay`（下面的 GitHub 仓库）
3. 双击 `studio\start-studio.cmd`：第一次会装依赖、编译，然后打开 Studio
::more tutorial.html#ch1-source
::card 想试远程（测试中）
1. 这台电脑开服务：在 `studio` 里运行 `npm run relay -- serve`，防火墙放行 47120 端口
2. `npm run platform` 打开平台，服务器地址填这台电脑的局域网 IP 加 `:47120`，注册账号并登录
3. Studio 顶栏「远程」→ 打开远程功能
4. 手机连同一个 Wi-Fi，装安卓 App，用同一个地址和账号登录，选这台电脑配对，回电脑上允许
::more tutorial.html#ch9-self
::cta
- [看详细教程](tutorial.html)
- [GitHub 仓库](https://github.com/kadhygh/AgentMonitorOverlay)
