import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ClientManifest, ShellBuild } from "./protocol.js";

// What the relay service hands out besides its API (publicDir): client/ — the client's content and manifest.json (the
// desktop client downloads it: hot update; a browser opens it at /app/) — and downloads/, the desktop client's zip.
// Everything is read on each request, so publishing a new client build needs no restart.

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".zip": "application/zip",
};

export class PublicFiles {
  readonly dir: string | null;

  constructor(dir: string | undefined) {
    this.dir = dir ? resolve(dir) : null;
  }

  /** A file under <dir>/<area>, never outside it. */
  file(area: "client" | "downloads", rel: string): string | null {
    if (!this.dir) return null;
    const base = join(this.dir, area);
    let file: string;
    try {
      file = normalize(join(base, decodeURIComponent(rel)));
    } catch {
      return null;
    }
    return file.startsWith(base + sep) && existsSync(file) && statSync(file).isFile() ? file : null;
  }

  manifest(): ClientManifest | null {
    const file = this.file("client", "manifest.json");
    try {
      return file ? (JSON.parse(readFileSync(file, "utf8")) as ClientManifest) : null;
    } catch {
      return null;
    }
  }

  /** downloads/AMO-Relay-win.json, written with the zip by relay-release --shell. */
  shell(): ShellBuild | null {
    if (!this.dir) return null;
    const file = join(this.dir, "downloads", "AMO-Relay-win.json");
    try {
      return existsSync(file) && existsSync(join(this.dir, "downloads", "AMO-Relay-win.zip")) ? (JSON.parse(readFileSync(file, "utf8")) as ShellBuild) : null;
    } catch {
      return null;
    }
  }

  downloads(): Array<{ name: string; size: number }> {
    if (!this.dir) return [];
    const dir = join(this.dir, "downloads");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((n) => statSync(join(dir, n)).isFile() && n.endsWith(".zip"))
      .map((name) => ({ name, size: statSync(join(dir, name)).size }));
  }
}

export function sendFile(res: ServerResponse, file: string, download = false): void {
  const headers: Record<string, string> = {
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": "no-store",
    "content-length": String(statSync(file).size),
  };
  if (download) headers["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(file.split(sep).pop() ?? "download")}`;
  res.writeHead(200, headers);
  // Streamed: the desktop client's zip is over 100 MB.
  createReadStream(file).pipe(res);
}

export function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The page to send people: download the desktop client, or use it in the browser; and the AMO platform, when it is here. */
export function landingPage(service: string, client: ClientManifest | null, files: Array<{ name: string; size: number }>, platform: { size: number } | null = null): string {
  // 2026-10-28, the user: everything goes through AMO 平台 — the page offers only its download. The relay client's zip and
  // the browser client (/app/) are no longer linked; their routes stay (installed clients load /client/ from here).
  void client;
  void files;
  const platformLink = platform
    ? `<a class="btn" href="/downloads/AMO-Platform-win.zip">下载 AMO 平台<small>安装和更新团队的 AMO 工具 · ${(platform.size / 1024 / 1024).toFixed(0)} MB</small></a>`
    : `<p class="muted">还没有放 AMO 平台的安装包。</p>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(service)} · AMO 中转</title>
<style>
:root{--bg:#efede8;--panel:#fbfaf7;--ink:#22201c;--muted:#8d877c;--line:#2a2723;--accent:#23436f;--on:#fbfaf7}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--panel:#181b1f;--ink:#e6e8eb;--muted:#7c8590;--line:#3a414a;--accent:#7fb2ff;--on:#0b1626}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif}
main{max-width:620px;margin:48px auto;padding:0 16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:24px 28px}
h1{font-size:22px;margin:0 0 4px;font-family:"Noto Serif SC","Songti SC",SimSun,serif}.muted{color:var(--muted)}
.btn{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:12px 0;padding:12px 16px;border-radius:3px;background:var(--accent);color:var(--on);text-decoration:none;font-weight:600}
.btn.alt{background:transparent;color:var(--accent);border:1px solid var(--accent)}
small{font-weight:400;opacity:.85}ol{padding-left:20px}code{background:var(--bg);padding:1px 6px;border-radius:4px;user-select:all}
</style></head><body><main><div class="card">
<h1>${escapeHtml(service)}</h1><p class="muted">团队的 AMO 工具（AMO Studio、AMO Reviewer、AMO 便签等）都从 AMO 平台安装和更新。</p>
${platformLink}
<ol class="muted">
<li>下载后解压到任意文件夹，双击 <code>AMO Platform.exe</code>。</li>
<li>登录时服务器地址填 <code id="addr"></code>，用团队服务器的账号登录。</li>
<li>在「工具」里安装要用的工具；第一次打开 AMO Studio 前，先在「目录」里设好 Studio 数据目录。</li>
<li>平台会待在托盘里，有新版时在这里更新，正在用的工具不会被打断。</li>
</ol>
</div></main><script>document.getElementById("addr").textContent=location.origin</script></body></html>`;
}
