# AMO 展示

<!-- 展示页（npm run tutorial:build 生成 out/html/showcase.html）。每屏：## 标题（10 个字以内）{#id}，下一行副标题
     （20 个字以内），::scene 放动画（showcase/*.js），::more 是右下角「怎么用 →」链到的教程章节。
     ::intro：这一屏是开场，标题和副标题在动画里出现，页面上只留给读屏软件；::kicker 是标题上面的小字；
     「! 」开头的行是标题下面的提醒（远程的安全）。最后一屏用 ::cta 加按钮列表。
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

## 从装平台开始 {#start}
Studio、Reviewer、便签、中转都从平台装和更新
::cta
- [下载 AMO 平台](http://172.16.8.85:47120/)
- [看详细教程](tutorial.html)
