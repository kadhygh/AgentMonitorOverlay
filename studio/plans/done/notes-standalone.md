# 便签独立成程序（2026-10-23）

> 状态：做完（2026-10-23，`2d6de8d4` 便签程序、`8b7dc390` 接入 Studio；Portable 和平台的 Studio 包都带着便签）。进度一节 2026-11-06 删掉了，原文见 git 历史（提交 f46907f2 之前的版本）。后来加的待办窗口见 `plans/done/todo.md`。

用户要的：Studio 重启不再打断便签；便签是 Studio 自带的独立小程序，Studio 里点「便签」时它在跑就呼出，没跑就先启动。
界面定稿在 Design 画布 https://claude.ai/artifact/BXngZSwVW1TwTWYkcGcnVr（「定稿」两张 + 设置、迁移、托盘、Studio 那一节）。
决定记在 memory `studio-notes-standalone`。

## 需求（用户原话整理）

1. 便签相关的设置都在便签里，入口是托盘图标的右键菜单（显示便签 / 设置… / 退出便签）。窗口 × 旁边不加设置按钮。
2. 设置里能设开机启动（托盘菜单里不放这一项）。
3. 同时只能跑一个：再启动就把已经在跑的那个呼出来。
4. 工作文件夹（页面内容和图片）：默认在用户目录；可以改，改的时候一键迁移（先复制、再切换，旧的留着）。
   显示占用大小（内容 / 图片 / 缓存），可以清理缓存、打开临时文件夹。缓存 = 不在任何一页里的图片 + 临时文件。
5. 便签自己的设置文件固定在用户目录（`%APPDATA%\AMO Notes\settings.json`），换工作文件夹也不变。
6. 窗口样式「甲」：整块一个色调（AMO 的纸色），页头下和底栏上各一条两边缩进 16px 的细线，文字直接写在纸上。
   按键提示：页码旁 `Ctrl 1–9`，× 上 `Esc`，复制上 `Ctrl ↵`（新：复制这一页并隐藏）。不在窗口里放「安全换行」开关。
   空白页列出按键（呼出快捷键按设置里实际绑定的显示），每个都要真的能用；第一次从 Studio 导入后显示一次「已从 AMO Studio 搬过来…」。

## 结构

- `packages/notes`：便签程序（Electron 主进程）。
  - `main.ts`：单实例锁（第二次启动 → 呼出）、托盘、全局快捷键、便签窗口（`#scratchpad`）和设置窗口（`#notes-settings`），开机启动（`app.setLoginItemSettings`）。
    界面直接用 `packages/ui/dist`（base 是 `./`，file:// 能加载）。
  - `server.ts`：本机小服务（127.0.0.1，随机端口，token），实现 Host 里便签用到的那几个接口，所以现有的便签界面（`useScratchpad`、图片上传和显示、事件推送）不用改：
    `GET /api/state`（空快照）、`WS /api/events`（`scratchpad.updated`）、`GET/PATCH /api/scratchpad`、`PUT /api/scratchpad/pages/:page`、
    `POST /api/attachments`、`GET /api/attachments/:id`、`GET /api/settings`（`scratchpadSafeNewlines`）。
    便签自己的：`/api/notes/settings`、`/api/notes/folder`（占用、迁移、清理缓存）、`/api/notes/show`、`/api/notes/import`。
    启动后把地址、token、pid 写进 `%APPDATA%\AMO Notes\running.json`，Studio 靠它找到便签。
  - `store.ts`：设置文件 + 工作文件夹（`pages.json`、`images/`、`cache/`）。
  - 测试用 `AMO_NOTES_HOME` 指到临时目录。
- 文档的纯函数（`readScratchpad`、`withPage`…）从 host 挪到 protocol（`protocol/src/scratchpad-doc.ts`），host 和 notes 共用。

## 接入 Studio 时定的

- Studio 的「便签」按钮 / 设置节改成呼出或启动独立便签；快捷键归便签自己，Studio 里原来的便签窗口和快捷键去掉。
- 第一次把 Studio 数据库里的便签页和图片导入便签（`/api/notes/import`），Studio 的旧数据保留。
