import { BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import { join } from "node:path";
import { acceptDataDir, writePortableConfig } from "./paths.js";

// First run of the portable build (no amo-studio.json yet): choose where data lives and check the environment before
// the Host starts. Credentials are only looked up (present or not); no secret is shown or kept.

export interface SetupChecks {
  codex: { ok: boolean; detail: string };
  /** The Claude Code the Claude channels run on: the person's own install (the portable build ships none). */
  claude: { ok: boolean; detail: string };
  credentials: Array<{ label: string; present: boolean; missing?: string }>;
  /** Tests do not look at this machine's tools and credentials. */
  skipped: boolean;
}

export async function setupChecks(testMode: boolean): Promise<SetupChecks> {
  if (testMode) return { codex: { ok: true, detail: "测试模式不检查" }, claude: { ok: true, detail: "" }, credentials: [], skipped: true };
  // Loaded only here: the Host package is large and the normal start never needs it in the shell.
  const host = await import("@amo-studio/host");
  let codex: SetupChecks["codex"];
  try {
    codex = { ok: true, detail: host.codexVersion() };
  } catch {
    codex = { ok: false, detail: "没有找到 codex（npm i -g @openai/codex 安装后重开 Studio）" };
  }
  const found = host.findClaudeCode();
  const version = found ? await host.claudeCodeVersion(found.path) : null;
  const claude = found
    ? { ok: true, detail: version ? `版本 ${version}` : found.path }
    : { ok: false, detail: "没有找到（PowerShell 里运行 irm https://claude.ai/install.ps1 | iex 安装）：Claude 订阅、GLM 和 Claude 方案的渠道要用它" };
  const reader = new host.WindowsCredentialReader();
  const seen = new Set<string>();
  const credentials: SetupChecks["credentials"] = [];
  // The Claude subscription signs in with the person's own Claude Code by default (设置 → 模型), not a saved token.
  const signedIn = host.localClaudeSignedIn(host.localClaudeHome());
  if (signedIn !== null) credentials.push({ label: "Claude 订阅（本机 Claude Code 的登录）", present: signedIn, missing: "没有找到：在终端运行 claude 登录一次" });
  for (const p of host.BUILTIN_PROFILES) {
    if (!p.credentialId || seen.has(p.credentialId) || p.credentialId === host.CLAUDE_SUBSCRIPTION_CREDENTIAL) continue;
    seen.add(p.credentialId);
    let present = false;
    try {
      present = !!reader.read(p.credentialId);
    } catch {
      present = false;
    }
    credentials.push({ label: `${p.label}（凭据 ${p.credentialId}）`, present });
  }
  return { codex, claude, credentials, skipped: false };
}

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AMO Studio · 首次设置</title>
<style>
:root{--bg:#111316;--bg-header:#15181b;--panel:#181b1f;--raised:#1f2328;--chip:#1d2125;--border:#2b3036;--border-strong:#3a414a;--text:#e6e8eb;--dim:#a0a8b2;--primary:#7fb2ff;--on-primary:#0b1626;--ok:#8fddb0;--bad:#f2b544;--error:#e5484d;--error-text:#ff8a8a;color-scheme:dark}
@media (prefers-color-scheme: light){:root{--bg:#efede8;--bg-header:#f8f7f3;--panel:#fbfaf7;--raised:#f4f2ed;--chip:#e7e3db;--border:#d9d3c7;--border-strong:#2a2723;--text:#22201c;--dim:#5d5850;--primary:#23436f;--on-primary:#fbfaf7;--ok:#3b7a4f;--bad:#93570a;--error:#a3302b;--error-text:#a3302b;color-scheme:light}}
html,body{height:100%}
body{margin:0;display:flex;flex-direction:column;font:14px/1.6 "Noto Sans SC","Microsoft YaHei UI","Segoe UI",sans-serif;background:var(--bg);color:var(--text)}
.tb{flex:none;height:40px;display:flex;align-items:center;gap:10px;padding-left:14px;border-bottom:1px solid var(--border);background:var(--bg-header);-webkit-app-region:drag;user-select:none}
.tb svg.mark{width:22px;height:22px;flex:none}
.tb-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:"Noto Serif SC","Songti SC","SimSun",serif;font-weight:600;font-size:16px}
.wc{align-self:stretch;display:flex;border-left:1px solid var(--border)}
.wc button{-webkit-app-region:no-drag;width:46px;height:100%;display:grid;place-items:center;padding:0;border:none;border-radius:0;background:transparent;color:var(--dim)}
.wc button:hover{background:var(--chip);color:var(--text)} .wc button.close:hover{background:var(--error);color:#fff}
.wc svg{fill:none;stroke:currentColor;stroke-width:1;shape-rendering:crispEdges}
.scroll{flex:1;min-height:0;overflow:auto}
main{max-width:620px;margin:32px auto 40px;padding:0 24px;display:flex;flex-direction:column;gap:18px}
h1{font-family:"Noto Serif SC","Songti SC","SimSun",serif;font-size:22px;font-weight:700;margin:0} .dim{color:var(--dim);font-size:13px}
section b{font-family:"Noto Serif SC","Songti SC","SimSun",serif}
.row{display:flex;gap:8px} input{flex:1;height:32px;padding:0 10px;border-radius:3px;border:1px solid var(--border-strong);background:var(--panel);color:var(--text);font:inherit}
button{height:32px;padding:0 14px;border-radius:3px;border:1px solid var(--border-strong);background:var(--panel);color:var(--text);cursor:pointer;font:inherit;font-size:13px}
button:hover{background:var(--raised)}
button.primary{background:var(--primary);color:var(--on-primary);border-color:var(--primary);font-weight:600}
ul{margin:0;padding-left:20px} .ok{color:var(--ok)} .bad{color:var(--bad)} #error{color:var(--error-text)}
</style></head><body>
<header class="tb"><svg class="mark" viewBox="24 24 464 464" aria-hidden="true"><g fill="none" stroke-linecap="round" stroke-linejoin="round"><g stroke="#fbfaf7" stroke-width="44" opacity="0.9"><path d="M80 168 V96 Q80 80 96 80 H168"/><path d="M344 80 H416 Q432 80 432 96 V168"/><path d="M432 344 V416 Q432 432 416 432 H344"/><path d="M168 432 H96 Q80 432 80 416 V344"/></g><g stroke="#22201c" stroke-width="28"><path d="M80 168 V96 Q80 80 96 80 H168"/><path d="M344 80 H416 Q432 80 432 96 V168"/><path d="M432 344 V416 Q432 432 416 432 H344"/><path d="M168 432 H96 Q80 432 80 416 V344"/></g></g><rect x="140" y="140" width="232" height="232" rx="62" fill="#2f5a92"/><g transform="translate(256 256) scale(0.78)"><circle cx="-52" cy="-22" r="32.3" fill="#fbfaf7"/><circle cx="52" cy="-22" r="32.3" fill="#fbfaf7"/><path d="M-62 46 Q0 92 62 46" fill="none" stroke="#fbfaf7" stroke-width="34" stroke-linecap="round"/></g></svg>
<span class="tb-name">AMO Studio · 首次设置</span>
<div class="wc" role="group" aria-label="窗口"><button id="wmin" aria-label="最小化" title="最小化"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 5.5 H9.5"/></svg></button><button id="wclose" class="close" aria-label="关闭" title="关闭（不保存，Studio 不会启动）"><svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0.5 0.5 L9.5 9.5 M9.5 0.5 L0.5 9.5"/></svg></button></div>
</header><div class="scroll"><main>
<h1>欢迎使用 AMO Studio</h1>
<div class="dim">这是 Portable 版：程序和数据都可以放在同一个文件夹里，拷走即可带走。</div>
<section><b>数据放在哪里</b><div class="dim">任务、会话记录、设置都存在这里。默认是程序旁边的 data 文件夹。</div>
<div class="row"><input id="dir" aria-label="数据目录"><button id="pick">选择…</button></div></section>
<section><b>环境检查</b><ul id="checks"><li class="dim">检查中…</li></ul>
<div class="dim">缺少的项目不影响打开 Studio，对应的模型暂时不能用。</div></section>
<div id="error" role="alert"></div>
<div class="row" style="justify-content:flex-end"><button class="primary" id="done">开始使用</button></div>
</main></div><script>
const $ = (id) => document.getElementById(id);
$("wmin").onclick = () => window.amo.windowControls.minimize();
$("wclose").onclick = () => window.amo.windowControls.close();
window.amo.setup.info().then((info) => {
  $("dir").value = info.defaultDir;
  const items = [];
  if (info.checks.skipped) items.push('<li class="dim">' + info.checks.codex.detail + '</li>');
  else {
    items.push('<li class="' + (info.checks.codex.ok ? 'ok' : 'bad') + '">Codex：' + info.checks.codex.detail + '</li>');
    items.push('<li class="' + (info.checks.claude.ok ? 'ok' : 'bad') + '">Claude Code：' + info.checks.claude.detail + '</li>');
    for (const c of info.checks.credentials) items.push('<li class="' + (c.present ? 'ok' : 'bad') + '">' + c.label + '：' + (c.present ? '已找到' : (c.missing || '没有找到')) + '</li>');
  }
  $("checks").innerHTML = items.join("");
});
$("pick").onclick = async () => { const d = await window.amo.setup.pick(); if (d) $("dir").value = d; };
$("done").onclick = async () => {
  $("error").textContent = "";
  const r = await window.amo.setup.done($("dir").value);
  if (r && r.error) $("error").textContent = r.error;
};
</script></body></html>`;

/**
 * Shows the setup window and resolves with the chosen data dir once it is saved (amo-studio.json next to the exe), or
 * null if the window is closed first.
 */
export function runSetup(options: { portableDir: string; configPath: string; defaultDir: string; preload: string; icon: string; testMode: boolean }): Promise<string | null> {
  return new Promise((resolveChoice) => {
    let settled = false;
    const win = new BrowserWindow({
      width: 720,
      height: 620,
      title: "AMO Studio · 首次设置",
      icon: options.icon,
      // The page follows the system's light or dark (no 主题 chosen yet), in AMO's colours.
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#111316" : "#efede8",
      // No system title bar (2026-10-29, AMO's style): the page draws its own, with 最小化 and 关闭 (a dialog-sized
      // window, not maximised).
      titleBarStyle: "hidden",
      maximizable: false,
      show: false,
      // Like every test window: off-screen, out of the taskbar, never focused (LOOP_RULES red line 7).
      ...(options.testMode ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {}),
      paintWhenInitiallyHidden: true,
      webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.removeMenu();
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      for (const ch of ["amo:setup-info", "amo:setup-pick", "amo:setup-done"]) ipcMain.removeHandler(ch);
      resolveChoice(value);
    };
    ipcMain.handle("amo:setup-info", async () => ({ defaultDir: options.defaultDir, checks: await setupChecks(options.testMode) }));
    ipcMain.handle("amo:setup-pick", async () => {
      const r = await dialog.showOpenDialog(win, { title: "选择数据目录", defaultPath: options.portableDir, properties: ["openDirectory", "createDirectory"] });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    });
    ipcMain.handle("amo:setup-done", (_event, choice: unknown) => {
      if (typeof choice !== "string" || !choice.trim()) return { error: "请填写数据目录" };
      try {
        const { dataDir, saved } = acceptDataDir(choice, options.portableDir);
        writePortableConfig(options.configPath, { dataDir: saved });
        finish(dataDir);
        win.destroy();
        return { ok: true };
      } catch (err) {
        return { error: `这个目录不能用：${(err as Error).message}` };
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.on("closed", () => finish(null));
    win.once("ready-to-show", () => (options.testMode ? win.showInactive() : win.show()));
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  });
}

export const SETUP_TEMP_PROFILE = (tmp: string) => join(tmp, `amo-studio-setup-${process.pid}`);
