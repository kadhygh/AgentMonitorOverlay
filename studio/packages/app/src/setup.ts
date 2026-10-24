import { BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { acceptDataDir, writePortableConfig } from "./paths.js";

// First run of the portable build (no amo-studio.json yet): choose where data lives and check the environment before
// the Host starts. Credentials are only looked up (present or not); no secret is shown or kept.

export interface SetupChecks {
  codex: { ok: boolean; detail: string };
  /** The Claude Code the Claude channels run on: the person's own install (the portable build ships none). */
  claude: { ok: boolean; detail: string };
  credentials: Array<{ label: string; present: boolean }>;
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
  for (const p of host.BUILTIN_PROFILES) {
    if (!p.credentialId || seen.has(p.credentialId)) continue;
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
body{margin:0;font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif;background:#111316;color:#e6e8eb}
main{max-width:620px;margin:40px auto;padding:0 24px;display:flex;flex-direction:column;gap:18px}
h1{font-size:20px;margin:0} .dim{color:#a0a8b2;font-size:13px}
.row{display:flex;gap:8px} input{flex:1;height:34px;padding:0 10px;border-radius:8px;border:1px solid #2b3036;background:#181b1f;color:#e6e8eb}
button{height:34px;padding:0 14px;border-radius:8px;border:1px solid #2b3036;background:#1f2328;color:#e6e8eb;cursor:pointer}
button.primary{background:#7fb2ff;color:#0b1626;border-color:#7fb2ff;font-weight:600}
ul{margin:0;padding-left:20px} .ok{color:#8fddb0} .bad{color:#f2b544} #error{color:#ff8a8a}
@media (prefers-color-scheme: light){body{background:#f5f6f8;color:#1b2027}.dim{color:#5a6572}input{background:#fff;color:#1b2027;border-color:#dbe0e6}button{background:#f2f4f7;color:#1b2027;border-color:#dbe0e6}button.primary{background:#2f6fd6;color:#fff;border-color:#2f6fd6}.ok{color:#1d7645}.bad{color:#b06f08}#error{color:#c22f35}}
</style></head><body><main>
<h1>欢迎使用 AMO Studio</h1>
<div class="dim">这是 Portable 版：程序和数据都可以放在同一个文件夹里，拷走即可带走。</div>
<section><b>数据放在哪里</b><div class="dim">任务、会话记录、设置都存在这里。默认是程序旁边的 data 文件夹。</div>
<div class="row"><input id="dir" aria-label="数据目录"><button id="pick">选择…</button></div></section>
<section><b>环境检查</b><ul id="checks"><li class="dim">检查中…</li></ul>
<div class="dim">缺少的项目不影响打开 Studio，对应的模型暂时不能用。</div></section>
<div id="error" role="alert"></div>
<div class="row" style="justify-content:flex-end"><button class="primary" id="done">开始使用</button></div>
</main><script>
const $ = (id) => document.getElementById(id);
window.amo.setup.info().then((info) => {
  $("dir").value = info.defaultDir;
  const items = [];
  if (info.checks.skipped) items.push('<li class="dim">' + info.checks.codex.detail + '</li>');
  else {
    items.push('<li class="' + (info.checks.codex.ok ? 'ok' : 'bad') + '">Codex：' + info.checks.codex.detail + '</li>');
    items.push('<li class="' + (info.checks.claude.ok ? 'ok' : 'bad') + '">Claude Code：' + info.checks.claude.detail + '</li>');
    for (const c of info.checks.credentials) items.push('<li class="' + (c.present ? 'ok' : 'bad') + '">' + c.label + '：' + (c.present ? '已找到' : '没有找到') + '</li>');
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
      backgroundColor: "#111316",
      show: false,
      // Like every test window: off-screen, out of the taskbar, never focused (LOOP_RULES red line 7).
      ...(options.testMode ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {}),
      paintWhenInitiallyHidden: true,
      webPreferences: { preload: options.preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
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
