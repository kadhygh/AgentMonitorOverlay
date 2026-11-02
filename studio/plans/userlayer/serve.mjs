// 把这个文件夹当静态网页发出去，给用户从别的设备用 Tailscale 看原型（2026-11-01 用户要求）。
// 只绑在本机的 Tailscale 地址上，局域网那张网卡看不到；只发这个文件夹里的文件。
// 用法：node studio/plans/userlayer/serve.mjs [--host 100.107.87.64] [--port 47130]
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const host = opt("--host", "100.107.87.64"), port = +opt("--port", 47130);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".css": "text/css; charset=utf-8", ".md": "text/plain; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = normalize(join(root, p));
    if (!file.startsWith(root + sep) || /[\\/]\./.test(p)) { res.writeHead(403).end(); return; }
    if (!(await stat(file)).isFile()) throw 0;
    // 不缓存：原型一直在改，刷新就是最新的
    res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    res.end(await readFile(file));
  } catch { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("没有这个文件"); }
}).listen(port, host, () => console.log(`userlayer 原型：http://${host}:${port}/`));
