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
:root{--bg:#efede8;--panel:#fbfaf7;--ink:#22201c;--muted:#8d877c;--line:#d9d3c7;--strong:#2a2723;--accent:#23436f;--accent-ink:#fbfaf7;--error:#a3302b}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--panel:#181b1f;--ink:#e6e8eb;--muted:#7c8590;--line:#2b3036;--strong:#3a414a;--accent:#7fb2ff;--accent-ink:#0b1626;--error:#ff8a8a}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{background:var(--bg);color:var(--ink);font:14px/1.6 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:16px}
.card{width:400px;max-width:100%;background:var(--panel);border:1px solid var(--strong);border-radius:8px;padding:28px;box-shadow:0 14px 36px rgb(0 0 0/16%)}
.brand{display:flex;gap:14px;align-items:center;margin-bottom:22px}
.mark{width:34px;height:34px;border-radius:3px;border:2px solid var(--ink);display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;font-family:"Noto Serif SC","Songti SC",SimSun,serif}
h1{font-size:19px;margin:0;font-family:"Noto Serif SC","Songti SC",SimSun,serif}.muted{color:var(--muted)}.small{font-size:12px}
.bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;margin:10px 0 6px}
.bar>div{height:100%;width:30%;background:var(--accent);border-radius:3px;transition:width .2s}
.bar.busy>div{animation:slide 1.1s ease-in-out infinite}
@keyframes slide{0%{margin-left:-30%}100%{margin-left:100%}}
.hide{display:none}
label{display:flex;flex-direction:column;gap:4px;font-size:13px;color:var(--muted)}
input{font:inherit;color:inherit;width:100%;border:1px solid var(--strong);background:var(--panel);border-radius:3px;padding:6px 10px;outline:none}
input:focus{border-color:var(--accent)}
.row{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
button{font:inherit;cursor:pointer;border:1px solid var(--strong);background:var(--panel);color:var(--ink);border-radius:3px;padding:5px 14px}
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
