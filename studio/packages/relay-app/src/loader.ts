// The loader page: the shell's own (it is never updated from the service), shown at each start while it connects,
// checks the client version and downloads content. It asks for the service address the first time, and offers retry
// or another address when the service cannot be reached. It talks to the shell through window.relayLoader.

export type LoaderState =
  | { step: "progress"; text: string; progress: number | null; server: string | null }
  | { step: "ask-server"; server: string; error: string | null }
  | { step: "error"; text: string; server: string | null; download: string | null };

export const LOADER_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>AMO 中转</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root{--bg:#f1eee7;--panel:#fbfaf7;--ink:#2b2822;--muted:#847c6f;--line:#ddd6c9;--accent:#3d6b5a;--accent-ink:#fff;--error:#b03a2e}
@media (prefers-color-scheme:dark){:root{--bg:#1b1a18;--panel:#24231f;--ink:#e8e3d8;--muted:#a0998b;--line:#3a3731;--accent:#7fb39d;--accent-ink:#13221c;--error:#f08a7e}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--ink);font:14px/1.6 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:16px}
.card{width:400px;max-width:100%;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:28px;box-shadow:0 8px 30px rgb(40 30 10/12%)}
.brand{display:flex;gap:14px;align-items:center;margin-bottom:22px}
.mark{width:44px;height:44px;border-radius:12px;background:var(--accent);color:var(--accent-ink);display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700}
h1{font-size:20px;margin:0}.muted{color:var(--muted)}.small{font-size:12px}
.bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin:10px 0 6px}
.bar>div{height:100%;width:30%;background:var(--accent);border-radius:3px;transition:width .2s}
.bar.busy>div{animation:slide 1.1s ease-in-out infinite}
@keyframes slide{0%{margin-left:-30%}100%{margin-left:100%}}
.hide{display:none}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
input{font:inherit;color:inherit;width:100%;border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:7px 10px;outline:none}
input:focus{border-color:var(--accent)}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:6px;padding:6px 14px}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}
.err{color:var(--error);font-size:13px;margin-top:8px;white-space:pre-wrap}
</style></head><body><div class="card">
<div class="brand"><div class="mark">中</div><div><h1>AMO 中转</h1><div class="muted small" id="where"></div></div></div>
<div id="progress"><div id="text">正在启动…</div><div class="bar busy" id="bar"><div></div></div></div>
<form id="ask" class="hide"><label>服务器地址<input id="server" placeholder="例如 192.168.1.20:47120" required></label>
<div class="muted small" style="margin-top:6px">在同事发给你的下载页上能看到这个地址。</div><div class="err" id="askErr"></div>
<div class="row"><button class="primary">连接</button></div></form>
<div id="error" class="hide"><div class="err" id="errText"></div>
<div class="row"><button id="download" class="hide">打开下载页</button><button id="change">换服务器地址</button><button class="primary" id="retry">重试</button></div></div>
</div><script>
const $=(id)=>document.getElementById(id);
const show=(id)=>["progress","ask","error"].forEach((x)=>$(x).classList.toggle("hide",x!==id));
let download=null;
window.relayLoader.onState((s)=>{
  $("where").textContent=s.server?("服务器 "+s.server):"";
  if(s.step==="progress"){show("progress");$("text").textContent=s.text;const bar=$("bar");
    if(s.progress==null){bar.classList.add("busy");bar.firstElementChild.style.width="30%"}
    else{bar.classList.remove("busy");bar.firstElementChild.style.width=Math.round(s.progress*100)+"%"}}
  if(s.step==="ask-server"){show("ask");$("server").value=s.server||"";$("askErr").textContent=s.error||"";$("server").focus();$("server").select()}
  if(s.step==="error"){show("error");$("errText").textContent=s.text;download=s.download;$("download").classList.toggle("hide",!download)}
});
$("ask").addEventListener("submit",(e)=>{e.preventDefault();$("askErr").textContent="";window.relayLoader.submitServer($("server").value)});
$("retry").onclick=()=>window.relayLoader.retry();
$("change").onclick=()=>window.relayLoader.changeServer();
$("download").onclick=()=>download&&window.relayLoader.open(download);
window.relayLoader.ready();
</script></body></html>`;
