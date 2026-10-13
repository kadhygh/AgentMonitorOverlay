# 界面方向预览（阶段 10）

`index.html`：5 套浅色方向（A 纸感编辑部、B 精密工具、C 柔和工作室、D 瑞士网格、E 东方留白），同一组页面、同一套结构，只换 `.app[data-dir]` 上的设计变量。
发布地址：https://claude.ai/artifact/AgBDnooFZe5cQxSdV4nAXZ

选定方向后：把该方向的变量块原样搬进 `packages/ui/src/styles/`，组件按这里的类名和结构改，最后拿应用截图和预览逐页对照。
本地打开需要外层加 `<!doctype html>`（发布时平台会自动包一层）。

## 选定（2026-10-13）

- 第一版用 **A 纸感编辑部**；其他方向在第一版完成后做成可切换的主题。
- 新建任务与切换的设计：`new-task.html`，发布地址 https://claude.ai/artifact/8ffsjGBneuZu6G21MuQNwY 。去掉弹窗，改成草稿任务页；模型、思考强度、权限、项目都改成一次点击的控件，不用下拉菜单。
