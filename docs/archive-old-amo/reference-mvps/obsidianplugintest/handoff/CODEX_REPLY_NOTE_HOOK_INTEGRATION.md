# Codex Reply Note Hook Integration Handoff

更新时间：2026-05-12

本文档说明如何把“Codex 每轮回复完成后，自动把 assistant 回复缓存成 note 文件”的 hook 接入到当前项目或迁移到其他项目。

## 1. 当前目标

需求：

- 当 Codex 一轮对话完成时，把 assistant 回复内容复制下来。
- 保存成 Markdown note 文件，方便后续其他工具、Obsidian、监控面板或其他 session 消费。
- 需要覆盖普通回复，也覆盖“assistant 要求用户选择或判断”的回复。

当前实现使用 Codex CLI 的 `Stop` hook。

选择 `Stop` 的原因：

- `Stop` 在一轮 assistant 回复完成后触发。
- `Stop` payload 中包含 `last_assistant_message`。
- 这正好对应“把刚刚回复用户的内容保存下来”。

官方文档：

```text
https://developers.openai.com/codex/hooks
```

## 2. 当前本项目实现

项目目录：

```text
D:\Projects\CommonProject\obsidianplugintest
```

Hook 配置：

```text
.codex/hooks.json
```

Hook 脚本：

```text
.codex/hooks/cache-stop-message.mjs
```

缓存输出：

```text
.codex/cache/latest-assistant-message.md
.codex/cache/latest-assistant-message.json
.codex/cache/assistant-turns/
.codex/cache/assistant-turn-errors.log
```

`.codex/cache/` 已加入 `.gitignore`。

## 3. 当前 hooks.json

当前配置使用绝对路径，适合 Windows 上从任意子目录启动当前项目时仍能找到脚本：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"D:\\Projects\\commonproject\\obsidianplugintest\\.codex\\hooks\\cache-stop-message.mjs\"",
            "timeout": 10,
            "statusMessage": "Caching assistant reply"
          }
        ]
      }
    ]
  }
}
```

迁移到其他项目时，至少要改这一行：

```json
"command": "node \"D:\\YourProject\\.codex\\hooks\\cache-stop-message.mjs\""
```

如果你确定总是从项目根目录启动 Codex，也可以改成相对路径：

```json
"command": "node .\\.codex\\hooks\\cache-stop-message.mjs"
```

但相对路径对启动 cwd 更敏感。Windows 上为了稳定，建议项目级 hook 初期使用绝对路径。

## 4. 脚本行为

脚本从 stdin 读取 Codex 传入的 hook payload：

```js
const rawInput = await readStdin();
const payload = rawInput.trim().length > 0 ? JSON.parse(rawInput) : {};
const message = normalizeMessage(payload.last_assistant_message);
```

如果 `last_assistant_message` 存在且非空，则生成一条 record：

```json
{
  "capturedAt": "...",
  "sessionId": "...",
  "turnId": "...",
  "model": "...",
  "hookEventName": "Stop",
  "cwd": "...",
  "transcriptPath": "...",
  "stopHookActive": false,
  "message": "assistant 回复正文"
}
```

然后同时写入：

```text
.codex/cache/latest-assistant-message.md
.codex/cache/latest-assistant-message.json
.codex/cache/assistant-turns/<timestamp>-<turnId>.md
.codex/cache/assistant-turns/<timestamp>-<turnId>.json
```

如果脚本出错：

- 错误写入 `.codex/cache/assistant-turn-errors.log`
- stdout 仍返回 `{"continue":true}`
- 避免因为缓存失败阻断 Codex 正常对话

## 5. 为什么 stdout 返回 JSON

Codex hook 对 stdout 有协议要求。当前脚本成功或失败都输出：

```json
{"continue":true}
```

这样 Codex 会继续正常运行。

不要在 hook stdout 中随便 `console.log()` 调试文本。调试信息应写入文件，否则可能干扰 hook 协议。

如果需要调试，建议写入：

```text
.codex/cache/assistant-turn-errors.log
```

或者增加一个专门的 debug log 文件。

## 6. 启用前提

Codex CLI 需要开启 hooks 功能。当前机器已验证：

```text
codex-cli 0.130.0
```

全局配置需要有：

```toml
[features]
hooks = true
```

当前机器的 `C:\Users\kadhy\.codex\config.toml` 已经满足。

项目需要被 Codex 信任。当前项目已在全局 config 中标记：

```toml
[projects.'d:\projects\commonproject\obsidianplugintest']
trust_level = "trusted"
```

其他项目迁移时也要确保对应项目是 trusted。

## 7. 首次使用步骤

在当前项目中最稳的启动方式：

```powershell
codex -C D:\Projects\CommonProject\obsidianplugintest
```

第一次加载新的项目级 hook 时，Codex 可能会弹出信任确认。允许后，后续回合结束时 `Stop` hook 会自动执行。

验证方式：

1. 重启 Codex。
2. 在该项目中发一句测试 prompt：

```text
测试 hook，请回复一句话。
```

3. 等 assistant 回复结束。
4. 检查：

```text
D:\Projects\CommonProject\obsidianplugintest\.codex\cache\latest-assistant-message.md
```

如果该文件更新，说明 hook 已经生效。

## 8. 离线模拟测试

不启动 Codex，也可以直接测试脚本写盘：

```powershell
node -e "process.stdout.write(JSON.stringify({hook_event_name:'Stop',session_id:'sess-test',turn_id:'turn-test-001',cwd:process.cwd(),model:'gpt-5.5',stop_hook_active:false,last_assistant_message:'Reply test with ASCII and 中文内容。'}))" | node .\.codex\hooks\cache-stop-message.mjs
```

预期 stdout：

```json
{"continue":true}
```

然后检查：

```powershell
Get-Item .codex\cache\latest-assistant-message.md
Get-ChildItem .codex\cache\assistant-turns
```

注意：Windows PowerShell 控制台编码可能让中文在终端里显示成问号，但脚本写文件使用的是 UTF-8。最终应以文件内容为准。

## 9. 迁移到其他项目的最小步骤

假设目标项目是：

```text
D:\Projects\SomeOtherProject
```

步骤：

1. 创建目录：

```text
D:\Projects\SomeOtherProject\.codex\hooks
```

2. 复制脚本：

```text
D:\Projects\CommonProject\obsidianplugintest\.codex\hooks\cache-stop-message.mjs
```

到：

```text
D:\Projects\SomeOtherProject\.codex\hooks\cache-stop-message.mjs
```

3. 创建或修改：

```text
D:\Projects\SomeOtherProject\.codex\hooks.json
```

内容示例：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"D:\\Projects\\SomeOtherProject\\.codex\\hooks\\cache-stop-message.mjs\"",
            "timeout": 10,
            "statusMessage": "Caching assistant reply"
          }
        ]
      }
    ]
  }
}
```

4. 在目标项目 `.gitignore` 中加入：

```gitignore
.codex/cache/
```

5. 从目标项目启动 Codex：

```powershell
codex -C D:\Projects\SomeOtherProject
```

6. 首次信任该项目 hook。

## 10. 输出文件格式

Markdown 文件示例：

```md
# Cached Codex Reply

- captured_at: 2026-05-12T15:13:02.902Z
- session_id: ...
- turn_id: ...
- model: gpt-5.5
- hook_event_name: Stop
- stop_hook_active: false
- cwd: D:\Projects\CommonProject\obsidianplugintest
- transcript_path: ...

---

assistant 回复正文
```

JSON 文件示例：

```json
{
  "capturedAt": "2026-05-12T15:13:02.902Z",
  "sessionId": "...",
  "turnId": "...",
  "model": "gpt-5.5",
  "hookEventName": "Stop",
  "cwd": "D:\\Projects\\CommonProject\\obsidianplugintest",
  "transcriptPath": "...",
  "stopHookActive": false,
  "message": "assistant 回复正文"
}
```

## 11. 让输出直接进入 Obsidian vault

当前脚本默认写入项目内：

```text
.codex/cache/
```

如果你想让每次回复直接生成 Obsidian note，可以改这几个路径：

```js
const cacheRoot = path.join(projectRoot, '.codex', 'cache');
const archiveRoot = path.join(cacheRoot, 'assistant-turns');
```

例如输出到某个 vault：

```js
const vaultRoot = 'D:\\Projects\\CommonProject\\obsidianplugintestvault';
const cacheRoot = path.join(vaultRoot, 'Codex Replies');
const archiveRoot = path.join(cacheRoot, 'assistant-turns');
```

建议不要一开始就直接写进正式 vault 的根目录。更稳的目录结构：

```text
Vault/
  Codex Replies/
    latest-assistant-message.md
    latest-assistant-message.json
    assistant-turns/
```

如果要让 note 更适合 Obsidian，可以把 `renderMarkdown(record)` 改成 frontmatter 格式：

```md
---
captured_at: 2026-05-12T15:13:02.902Z
session_id: ...
turn_id: ...
model: gpt-5.5
source: codex-stop-hook
---

# Codex Reply

assistant 回复正文
```

## 12. 后续扩展方向

### 12.1 同时保存用户问题和 assistant 回复

当前 `Stop` payload 主要用于 assistant 最后一条回复。如果要保存完整 Q/A，需要进一步读取 transcript 或使用其他 hook 事件组合，例如：

- `UserPromptSubmit` 保存用户 prompt
- `Stop` 保存 assistant reply
- 通过 `session_id` / `turn_id` 做关联

当前文档没有实现这一步。

### 12.2 只在“需要用户决策”时生成特殊 note

可以在 `message` 上做简单规则判断，例如包含：

```text
请选择
需要你确认
我需要你判断
是否继续
```

然后额外写入：

```text
.codex/cache/needs-decision/latest.md
```

但这种 regex 会有误判。更稳的方式是让 assistant 在需要用户决策时输出固定 marker，不过这会改变日常回复风格，暂时不建议作为默认方案。

### 12.3 输出到监控工具或本地服务

除了写文件，也可以在 hook 中 POST 到本地服务，例如：

```text
http://127.0.0.1:xxxx/codex/replies
```

注意：

- hook 必须短时间完成。
- 网络失败不要阻断 Codex。
- 仍建议保留文件落盘作为兜底。

## 13. 风险和边界

- Project-local hooks 和 global hooks 是叠加加载，不是覆盖关系。全局 hook 如果坏了，项目 hook 仍可能被全局 hook 的错误干扰。
- 迁移项目时，如果 `.codex/hooks.json` 使用绝对路径，必须改成目标项目路径。
- 脚本不要输出普通 debug 文本到 stdout。
- 脚本应尽量短、快、无外部依赖；当前只依赖 Node 内置模块。
- 如果 Node 不在 PATH 中，hook 会失败。当前机器可以运行 `node`。
- 如果 Codex CLI 版本升级，hook payload 字段可能变化；至少要重新验证 `last_assistant_message` 是否仍存在。

## 14. 给其他 session 的建议启动提示

可以把下面这段直接喂给新的 Codex session：

```text
你接手一个 Codex Stop hook 接入任务。
请先阅读 docs/CODEX_REPLY_NOTE_HOOK_INTEGRATION.md、.codex/hooks.json、.codex/hooks/cache-stop-message.mjs。
当前 hook 在 Stop 事件读取 stdin JSON 的 last_assistant_message，并写入 .codex/cache/latest-assistant-message.md、latest-assistant-message.json 和 assistant-turns 归档。
迁移到其他项目时，要复制 .codex/hooks/cache-stop-message.mjs，创建项目级 .codex/hooks.json，并把 command 路径改成目标项目绝对路径。
不要把 .codex/cache/ 提交到仓库。
如果要改成直接生成 Obsidian note，请优先修改 cacheRoot/archiveRoot 和 renderMarkdown(record)，并保持 stdout 只输出 {"continue":true}。
```
