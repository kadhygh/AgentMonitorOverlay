import { escapeHtml } from "./public.js";
import { ISSUE_STATUS_LABEL, ISSUE_TOOLS } from "./issues-protocol.js";

// 问题页 (/issues, 2026-10-31, plans/issues.md): the person reports AMO's problems here — a line or two, screenshots
// pasted or dropped — and talks them over with the AI Studio's 值守 sets on them; 发布打包 asks for a test build. Plain
// page, no framework: everything is drawn with textContent. Signing in takes the team account (the key is kept in this
// browser); the AMO platform can open it with `#key=…&v=studio:0.9.16,notes:0.9.7` (the installed versions fill the
// version box). New things are asked for every few seconds while the page is in front.

export function issuesPage(service: string): string {
  const labels = JSON.stringify(ISSUE_STATUS_LABEL);
  const tools = JSON.stringify(ISSUE_TOOLS);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(service)} · 问题</title>
<style>
:root{--bg:#efede8;--panel:#fbfaf7;--ink:#22201c;--muted:#8d877c;--line:#2a2723;--soft:#d9d5cc;--accent:#23436f;--on:#fbfaf7;--danger:#a3402c;--ok:#3d7a4f;--warn:#9a6a12;--ai:#e8eef7}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--panel:#181b1f;--ink:#e6e8eb;--muted:#7c8590;--line:#3a414a;--soft:#2a3038;--accent:#7fb2ff;--on:#0b1626;--danger:#e08a73;--ok:#7cc48f;--warn:#e0b45a;--ai:#1c2635}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:12px 20px;border-bottom:1px solid var(--soft);background:var(--panel)}
h1{font-size:18px;margin:0;font-family:"Noto Serif SC","Songti SC",SimSun,serif}
.muted{color:var(--muted)}.grow{flex:1}
button{font:inherit;padding:4px 12px;border:1px solid var(--line);border-radius:3px;background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);color:var(--on);border-color:var(--accent)}button.danger{color:var(--danger);border-color:var(--danger)}
button:disabled{opacity:.5;cursor:default}
input,select,textarea{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:3px;background:var(--panel);color:var(--ink)}
textarea{width:100%;resize:vertical;min-height:72px}
.wrap{display:grid;grid-template-columns:minmax(300px,420px) 1fr;gap:16px;padding:16px 20px;align-items:start}
@media (max-width:860px){.wrap{grid-template-columns:1fr}}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-bottom:12px}
.card h2{font-size:14px;margin:0 0 8px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.release{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
.release b{font-size:15px}
.thumbs{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
.thumb{position:relative;width:84px;height:64px;border:1px solid var(--soft);border-radius:4px;overflow:hidden;background:var(--bg)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}
.thumb button{position:absolute;top:2px;right:2px;padding:0 6px;font-size:12px;background:var(--panel)}
.thumb.up{opacity:.5}
.drop{outline:2px dashed var(--accent);outline-offset:2px}
.list{list-style:none;margin:0;padding:0}
.list li{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;padding:8px 10px;border-radius:4px;cursor:pointer;border:1px solid transparent}
.list li:hover{background:var(--bg)}.list li[aria-current=true]{border-color:var(--line);background:var(--bg)}
.num{color:var(--muted);font-variant-numeric:tabular-nums}
.t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{grid-column:2;font-size:12px;color:var(--muted)}
.st{display:inline-block;padding:0 6px;border-radius:3px;border:1px solid currentColor;font-size:12px;line-height:18px;white-space:nowrap}
.st-new{color:var(--accent)}.st-working,.st-asking{color:var(--warn)}.st-fixed,.st-released{color:var(--ok)}.st-stuck{color:var(--danger)}.st-discuss{color:var(--accent)}.st-closed{color:var(--muted)}
.tabs{display:flex;gap:4px;margin-bottom:6px}.tabs .n{margin-left:4px;font-variant-numeric:tabular-nums}.tabs button[aria-pressed=true]{background:var(--ink);color:var(--panel)}
.entry{padding:10px 12px;border-radius:6px;border:1px solid var(--soft);margin:8px 0}
.entry.ai{background:var(--ai)}
.entry.status{border-style:dashed;padding:4px 12px;font-size:12px;color:var(--muted)}
.who{font-size:12px;color:var(--muted);margin-bottom:4px}.who b{color:var(--ink)}
.tag{font-size:11px;border:1px solid var(--accent);color:var(--accent);border-radius:3px;padding:0 4px;margin-left:4px}
.body{white-space:pre-wrap;word-break:break-word}
.msg{margin:8px 0 0;padding:6px 10px;border-radius:4px;background:var(--bg)}.msg.err{color:var(--danger)}
.empty{padding:24px;text-align:center}
#viewer{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;cursor:zoom-out}
#viewer img{max-width:94vw;max-height:94vh;box-shadow:0 4px 24px rgba(0,0,0,.4)}
[hidden]{display:none!important}
</style></head><body>
<header><h1>${escapeHtml(service)} · 问题</h1><span class="muted grow" id="sub">遇到 AMO 的问题写在这里，附上截图；AI 会接着修，修好的攒够了就发测试版。</span><span id="me" class="muted"></span><button type="button" id="logout" hidden>退出</button></header>
<form id="login" class="card" style="max-width:420px;margin:32px auto" hidden><h2>用团队服务器的账号登录</h2><div class="row"><input id="name" placeholder="登录名" autocomplete="username"><input id="pw" type="password" placeholder="密码" autocomplete="current-password"><button class="primary">登录</button></div><div id="loginMsg"></div></form>
<div class="wrap" id="app" hidden>
<section>
<div class="card release" data-testid="issues-release"><span id="relText" class="grow"></span><button type="button" id="relBtn" class="primary">发布打包</button></div>
<form class="card" id="newForm" data-testid="issues-new"><h2>报一个问题</h2>
<textarea id="newBody" placeholder="哪里不对：在哪个界面、做了什么、看到了什么。截图直接粘贴（Ctrl+V）或拖进来。Ctrl+Enter 提交。"></textarea>
<div class="thumbs" id="newThumbs"></div>
<div class="row"><select id="newTool"><option value="">哪个工具（可不选）</option></select><input id="newVersion" placeholder="版本（可不填）" size="10"><span class="grow"></span><button class="primary" id="newSubmit">提交</button></div>
<div id="newMsg"></div></form>
<div class="card"><div class="tabs"><button type="button" data-filter="you" aria-pressed="false" data-testid="issues-tab-you" title="等你回答、卡住了、建议单开讨论，而且最后一条是 AI 写的">要你看<span class="n" id="youN"></span></button><button type="button" data-filter="open" aria-pressed="true">进行中</button><button type="button" data-filter="all" aria-pressed="false">全部</button></div><ul class="list" id="list" data-testid="issues-list"></ul></div>
</section>
<section id="detail" class="card" data-testid="issues-detail"><div class="empty muted">选左边的一个问题看它的来往。</div></section>
</div>
<div id="viewer" hidden><img alt=""></div>
<script>
var LABELS = ${labels}, TOOLS = ${tools};
var SYMBOL = { new: "○", working: "◐", asking: "?", fixed: "✓", released: "✓", stuck: "!", discuss: "◇", closed: "–" };
var KEY = "amo-issues-key", NAME = "amo-issues-name";
var $ = function (id) { return document.getElementById(id); };
var state = { key: "", name: "", issues: {}, rev: 0, release: null, selected: null, filter: "open", detail: null, versions: {} };
function store(k, v) { try { if (v) localStorage.setItem(k, v); else localStorage.removeItem(k); } catch (e) {} }
function load(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
function say(where, text, err) { var el = $(where); el.innerHTML = ""; if (!text) return; var d = document.createElement("div"); d.className = "msg" + (err ? " err" : ""); d.textContent = text; el.appendChild(d); }
function call(method, path, body, raw) {
  var headers = { authorization: "Bearer " + state.key };
  if (!raw) headers["content-type"] = "application/json";
  return fetch(path, { method: method, headers: headers, body: raw ? raw : body ? JSON.stringify(body) : undefined }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (r.status === 401) { signOut(); throw new Error("登录已失效，重新登录一次"); }
      if (!r.ok) throw new Error(j.message || ("出错了（" + r.status + "）"));
      return j;
    });
  });
}
function when(ms) { if (!ms) return ""; var d = new Date(ms), now = new Date(); var t = d.toTimeString().slice(0, 5); return d.toDateString() === now.toDateString() ? t : (d.getMonth() + 1) + "-" + d.getDate() + " " + t; }
function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function badge(st) { return el("span", "st st-" + st, SYMBOL[st] + " " + LABELS[st]); }
function imgUrl(id) { return "/api/issues/images/" + id + "?key=" + encodeURIComponent(state.key); }
function view(id) { var v = $("viewer"); v.querySelector("img").src = imgUrl(id); v.hidden = false; }
$("viewer").onclick = function () { this.hidden = true; };

// --- signing in
function signOut() { store(KEY, ""); store(NAME, ""); state.key = ""; showLogin(); }
function showLogin() { $("app").hidden = true; $("login").hidden = false; $("logout").hidden = true; $("me").textContent = ""; }
function signedIn() { $("login").hidden = true; $("app").hidden = false; $("logout").hidden = false; $("me").textContent = state.name; refresh(true); }
$("login").onsubmit = function (ev) {
  ev.preventDefault();
  fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: $("name").value, password: $("pw").value }) })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.message || "登录不了"); return j; }); })
    .then(function (j) { state.key = j.key; state.name = j.name; store(KEY, j.key); store(NAME, j.name); $("pw").value = ""; signedIn(); })
    .catch(function (e) { say("loginMsg", e.message, true); });
};
$("logout").onclick = function () { call("POST", "/api/logout").catch(function () {}); signOut(); };

// --- pictures: pasted or dropped, uploaded at once; the form sends their ids
function picker(box, thumbs, msg) {
  var list = [];
  function draw() {
    thumbs.innerHTML = "";
    list.forEach(function (p, i) {
      var t = el("div", "thumb" + (p.id ? "" : " up")); var im = document.createElement("img"); im.src = p.url; im.alt = p.name; if (p.id) im.onclick = function () { view(p.id); }; t.appendChild(im);
      var x = el("button", "", "×"); x.type = "button"; x.title = "去掉这张"; x.onclick = function () { list.splice(i, 1); draw(); }; t.appendChild(x); thumbs.appendChild(t);
    });
  }
  function add(file) {
    if (!/^image\\//.test(file.type)) { say(msg, "只能贴图片", true); return; }
    var p = { name: file.name || "截图.png", url: URL.createObjectURL(file), id: null }; list.push(p); draw();
    call("POST", "/api/issues/images?name=" + encodeURIComponent(p.name) + "&type=" + encodeURIComponent(file.type), null, file)
      .then(function (j) { p.id = j.image.id; draw(); })
      .catch(function (e) { list.splice(list.indexOf(p), 1); draw(); say(msg, e.message, true); });
  }
  box.addEventListener("paste", function (e) { var items = (e.clipboardData && e.clipboardData.files) || []; if (!items.length) return; e.preventDefault(); for (var i = 0; i < items.length; i++) add(items[i]); });
  box.addEventListener("dragover", function (e) { e.preventDefault(); box.classList.add("drop"); });
  box.addEventListener("dragleave", function () { box.classList.remove("drop"); });
  box.addEventListener("drop", function (e) { e.preventDefault(); box.classList.remove("drop"); var f = e.dataTransfer.files; for (var i = 0; i < f.length; i++) add(f[i]); });
  return {
    ids: function () { return list.filter(function (p) { return p.id; }).map(function (p) { return p.id; }); },
    busy: function () { return list.some(function (p) { return !p.id; }); },
    clear: function () { list = []; draw(); },
  };
}

// --- new issue
Object.keys(TOOLS).forEach(function (id) { var o = el("option", "", TOOLS[id]); o.value = id; $("newTool").appendChild(o); });
$("newTool").onchange = function () { var v = state.versions[this.value]; if (v) $("newVersion").value = v; };
var newPics = picker($("newForm"), $("newThumbs"), "newMsg");
$("newBody").addEventListener("keydown", function (e) { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); $("newForm").requestSubmit(); } });
$("newForm").onsubmit = function (ev) {
  ev.preventDefault();
  if (newPics.busy()) return say("newMsg", "截图还在传，稍等一下", true);
  var body = $("newBody").value.trim(), images = newPics.ids();
  if (!body && !images.length) return say("newMsg", "写一句话或贴一张截图", true);
  $("newSubmit").disabled = true;
  call("POST", "/api/issues", { body: body, images: images, tool: $("newTool").value, version: $("newVersion").value })
    .then(function (j) { $("newBody").value = ""; newPics.clear(); say("newMsg", "已提交 #" + j.issue.number); put(j.issue); select(j.issue.number); })
    .catch(function (e) { say("newMsg", e.message, true); })
    .then(function () { $("newSubmit").disabled = false; });
};

// --- the list
document.querySelectorAll("[data-filter]").forEach(function (b) { b.onclick = function () { state.filter = b.getAttribute("data-filter"); document.querySelectorAll("[data-filter]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); drawList(); }; });
function put(issue) { var had = state.issues[issue.number]; state.issues[issue.number] = Object.assign({}, had || {}, issue); }
function open(i) { return i.status !== "released" && i.status !== "closed"; }
// 要你看 (2026-10-31): what waits for the person — the AI asked, got stuck or suggests talking it over, and has not
// been answered yet.
function forYou(i) { return (i.status === "asking" || i.status === "stuck" || i.status === "discuss") && !i.awaitsAi; }
function drawList() {
  var ul = $("list"); ul.innerHTML = "";
  var all = Object.keys(state.issues).map(function (k) { return state.issues[k]; }).sort(function (a, b) { return b.number - a.number; });
  var you = all.filter(forYou).length; $("youN").textContent = you ? String(you) : "";
  var shown = all.filter(function (i) { return state.filter === "all" || (state.filter === "you" ? forYou(i) : open(i)); });
  if (!shown.length) { ul.appendChild(el("li", "muted", !all.length ? "还没有问题。" : state.filter === "you" ? "没有要你看的。" : "没有进行中的问题。")); return; }
  shown.forEach(function (i) {
    var li = el("li"); li.setAttribute("aria-current", String(i.number === state.selected)); li.setAttribute("data-testid", "issue-row");
    li.appendChild(el("span", "num", "#" + i.number)); li.appendChild(el("span", "t", i.title));
    var meta = el("span", "meta"); meta.appendChild(badge(i.status));
    meta.appendChild(document.createTextNode(" " + [i.tool ? TOOLS[i.tool] : "", when(i.updatedAt), i.worker].filter(Boolean).join(" · ")));
    li.appendChild(meta); li.onclick = function () { select(i.number); }; ul.appendChild(li);
  });
}
function drawRelease() {
  var r = state.release; if (!r) return;
  var fixed = Object.keys(state.issues).filter(function (k) { return state.issues[k].status === "fixed"; }).length;
  var parts = ["待发布 " + fixed + " 个"];
  if (r.last) parts.push("上次发布：" + r.last.version + "（" + when(r.last.at) + "）");
  if (r.requestedAt) parts.push("已请求发布（" + when(r.requestedAt) + "），等 Studio 打包…");
  $("relText").textContent = parts.join(" · ");
  $("relBtn").textContent = r.requestedAt ? "取消发布请求" : "发布打包";
  $("relBtn").className = r.requestedAt ? "" : "primary";
}
$("relBtn").onclick = function () {
  var on = !(state.release && state.release.requestedAt);
  call("POST", "/api/issues/release", { on: on }).then(function (j) { state.release = j.release; drawRelease(); }).catch(function (e) { alert(e.message); });
};

// --- one issue: its head and entries are drawn again when it changes; the comment box below stays (what is being
// written, the pictures pasted) until another issue is chosen.
var commentPics = null, drawnFor = null;
function select(n) { state.selected = n; drawList(); call("GET", "/api/issues/" + n).then(function (j) { if (state.selected !== n) return; put(j.issue); state.detail = j.issue; drawDetail(); }).catch(function (e) { alert(e.message); }); }
function drawDetail() {
  var i = state.detail, box = $("detail"); if (!i) return;
  if (drawnFor !== i.number) { box.innerHTML = ""; box.appendChild(el("div", "", "")).id = "entries"; drawForm(i); drawnFor = i.number; }
  var top = $("entries"); top.innerHTML = "";
  var head = el("div", "row"); head.appendChild(el("span", "num", "#" + i.number)); var h = el("h2", "grow", i.title); h.style.margin = "0"; head.appendChild(h); head.appendChild(badge(i.status));
  var act = open(i) ? el("button", "", "不修了") : el("button", "", "重新打开"); act.type = "button"; act.setAttribute("data-testid", "issue-toggle");
  act.onclick = function () { patch(i.number, { status: open(i) ? "closed" : "new" }); }; head.appendChild(act); top.appendChild(head);
  var meta = [i.tool ? TOOLS[i.tool] : "", i.version ? "版本 " + i.version : "", i.fixedIn ? "发布在 " + i.fixedIn : "", i.worker ? "处理：" + i.worker : ""].filter(Boolean).join(" · ");
  if (meta) top.appendChild(el("div", "muted", meta));
  (i.entries || []).forEach(function (e) {
    if (e.kind === "status") { top.appendChild(el("div", "entry status", (e.ai ? "AI · " : e.author + " · ") + when(e.at) + " · " + e.body)); return; }
    var d = el("div", "entry" + (e.ai ? " ai" : "")); d.setAttribute("data-testid", "issue-entry");
    var who = el("div", "who"); who.appendChild(el("b", "", e.ai ? "AI" : e.author)); if (e.ai) who.appendChild(el("span", "tag", "代 " + e.author + " 回复")); who.appendChild(document.createTextNode(" · " + when(e.at))); d.appendChild(who);
    if (e.body) d.appendChild(el("div", "body", e.body));
    if (e.images.length) { var th = el("div", "thumbs"); e.images.forEach(function (im) { var t = el("div", "thumb"); var img = document.createElement("img"); img.src = imgUrl(im.id); img.alt = im.name; img.onclick = function () { view(im.id); }; t.appendChild(img); th.appendChild(t); }); d.appendChild(th); }
    top.appendChild(d);
  });
  var ta = $("commentText"); if (ta) ta.placeholder = i.status === "discuss" ? "想让 AI 直接修就在这里说一声；要单开讨论就在 Studio 里开个会话，谈完把这条关掉或留个话。Ctrl+Enter 发送" : i.status === "asking" ? "回答 AI 的问题…（截图可以粘贴或拖进来）Ctrl+Enter 发送" : open(i) ? "补充点什么…Ctrl+Enter 发送" : "还不对？写在这里，问题会重新打开。";
}
function drawForm(i) {
  var form = el("form", "card"); form.style.margin = "12px 0 0"; form.setAttribute("data-testid", "issue-comment");
  var ta = el("textarea"); ta.id = "commentText"; form.appendChild(ta);
  var thumbs = el("div", "thumbs"); form.appendChild(thumbs);
  var row = el("div", "row"); row.appendChild(el("span", "grow")); var send = el("button", "primary", "发送"); row.appendChild(send); form.appendChild(row);
  var msg = el("div"); msg.id = "commentMsg"; form.appendChild(msg); $("detail").appendChild(form);
  commentPics = picker(form, thumbs, "commentMsg");
  ta.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); form.requestSubmit(); } });
  form.onsubmit = function (ev) {
    ev.preventDefault();
    if (commentPics.busy()) return say("commentMsg", "截图还在传，稍等一下", true);
    var body = ta.value.trim(), images = commentPics.ids(); if (!body && !images.length) return;
    send.disabled = true;
    call("POST", "/api/issues/" + i.number + "/entries", { body: body, images: images })
      .then(function (j) { ta.value = ""; commentPics.clear(); say("commentMsg", ""); put(j.issue); state.detail = j.issue; drawList(); drawDetail(); })
      .catch(function (e) { say("commentMsg", e.message, true); })
      .then(function () { send.disabled = false; });
  };
}
function patch(n, body) { call("PATCH", "/api/issues/" + n, body).then(function (j) { put(j.issue); state.detail = j.issue; drawList(); drawDetail(); }).catch(function (e) { alert(e.message); }); }

// --- keeping up: what changed since the last look, every few seconds while the page is in front
var timer = null;
function refresh(all) {
  return call("GET", "/api/issues" + (all || !state.rev ? "" : "?after=" + state.rev)).then(function (j) {
    j.issues.forEach(put); state.rev = j.rev; state.release = j.release; drawList(); drawRelease();
    if (state.selected && j.issues.some(function (x) { return x.number === state.selected; })) select(state.selected);
  }).catch(function () {});
}
setInterval(function () { if (state.key && !document.hidden) refresh(false); }, 5000);
document.addEventListener("visibilitychange", function () { if (!document.hidden && state.key) refresh(false); });

// --- start: a key from the platform's link, or the one kept here
(function () {
  var h = new URLSearchParams(location.hash.slice(1));
  if (h.get("key")) { state.key = h.get("key"); store(KEY, state.key); }
  (h.get("v") || "").split(",").forEach(function (p) { var kv = p.split(":"); if (kv[0] && kv[1]) state.versions[kv[0]] = kv[1]; });
  if (h.get("key")) history.replaceState(null, "", location.pathname);
  state.key = state.key || load(KEY);
  if (!state.key) return showLogin();
  call("GET", "/api/me").then(function (j) { state.name = j.name; store(NAME, j.name); signedIn(); }).catch(function () { showLogin(); });
})();
</script></body></html>`;
}
