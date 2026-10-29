# AMO 展示

<!-- 展示页（npm run tutorial:build 生成 out/html/showcase.html）。每屏：## 标题（10 个字以内）{#id}，下一行副标题
     （20 个字以内），::scene 放循环动画（showcase/*.js），::more 是右下角「怎么用 →」链到的教程章节。最后一屏用
     ::cta 加按钮列表。按钮名、功能名写成 [[…]]，和教程一样会被单测核对。 -->

## 所有 AI，一个工作台 {#hero}
Claude、Codex、DeepSeek 同时在看板上跑
::scene sc-board
::more tutorial.html#ch1

## 只在需要你时叫你 {#focus}
Focus 小窗只列要你批准、回答的事
::scene sc-focus
::more tutorial.html#ch1-approve

## 专题 › 任务 › 会话 {#layers}
一个专题跨几个项目，一个任务开几段会话
::scene sc-layers
::more tutorial.html#ch0-map

## 画布上看全局 {#canvas}
状态、依赖、AI 的提问都在一张图上
::scene sc-canvas
::more tutorial.html

## 直接带你看关键几行 {#review}
AI 打开 Review，你写批注复制回对话
::scene sc-review
::more tutorial.html#ch1-review

## 卡住了就去问人 {#relay}
策划的 AI 经中转问程序，拿到回复接着改
::scene sc-relay
::more tutorial.html

## 换台电脑接着用 {#remote}
局域网中，在多设备之间流转自由使用
::scene sc-remote
::more tutorial.html

## 从装平台开始 {#start}
Studio、中转、Reviewer 都从平台装和更新
::cta
- [下载 AMO 平台](http://172.16.8.85:47120/)
- [看详细教程](tutorial.html)
