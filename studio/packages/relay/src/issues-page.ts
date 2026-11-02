import { escapeHtml } from "./public.js";
import { ISSUE_BUILD_QUIET_MS, ISSUE_STATUS_LABEL, ISSUE_TOOLS } from "./issues-protocol.js";

// 问题页 (/issues, 2026-10-31, plans/issues.md): the person reports AMO's problems here — a line or two, screenshots
// pasted or dropped — and talks them over with the AI Studio's 值守 sets on them; 发布打包 asks for a test build. Plain
// page, no framework: everything is drawn with textContent. Signing in takes the team account (the key is kept in this
// browser); the AMO platform can open it with `#key=…&v=studio:0.9.16,notes:0.9.7` (the installed versions fill the
// version box). New things are asked for every few seconds while the page is in front.
// 2026-10-31 改版 (the user: 能看到是否在打包和进度；一个问题不要一直展开占满屏幕): the build `npm run release` reports
// is a bar on top; the list is the page's main thing, 报问题 opens on demand; one issue opens beside the list (in its
// place on a narrow window) and closes again, its older entries folded.
// 2026-10-31 晚: each step of the build its own bar (against the same step's median in the last builds) and a table of
// the last builds like Jenkins' stage view; 前往讨论 hands an issue to the person's own session, whose id shows to copy.
// 2026-11-03 维护者 (the user): someone who is not a maintainer sees only their own issues, and what they report waits
// in 待审核; a maintainer sees everyone's, reviews the others' (确认制作 / 打回 with the reason written below) and alone
// has 发布打包 and 前往讨论. The service enforces it; the page only leaves out what is not theirs to press.

export function issuesPage(service: string): string {
  const labels = JSON.stringify(ISSUE_STATUS_LABEL);
  const tools = JSON.stringify(ISSUE_TOOLS);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(service)} · 问题</title>
<style>
:root{--bg:#efede8;--panel:#fbfaf7;--ink:#22201c;--muted:#8d877c;--line:#2a2723;--soft:#d9d5cc;--accent:#23436f;--on:#fbfaf7;--danger:#a3402c;--ok:#3d7a4f;--warn:#9a6a12;--ai:#e8eef7}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--panel:#181b1f;--ink:#e6e8eb;--muted:#7c8590;--line:#3a414a;--soft:#2a3038;--accent:#7fb2ff;--on:#0b1626;--danger:#e08a73;--ok:#7cc48f;--warn:#e0b45a;--ai:#1c2635}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:10px 20px;border-bottom:1px solid var(--soft);background:var(--panel)}
h1{font-size:18px;margin:0;font-family:"Noto Serif SC","Songti SC",SimSun,serif;white-space:nowrap}
.muted{color:var(--muted)}.grow{flex:1;min-width:0}
#sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{font:inherit;padding:4px 12px;border:1px solid var(--line);border-radius:3px;background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);color:var(--on);border-color:var(--accent)}button.link{border:0;padding:2px 4px;color:var(--accent)}
button:disabled{opacity:.5;cursor:default}
input,select,textarea{font:inherit;padding:6px 8px;border:1px solid var(--line);border-radius:3px;background:var(--panel);color:var(--ink)}
textarea{width:100%;resize:vertical;min-height:72px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 16px}
.card h2{font-size:14px;margin:0 0 8px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
/* the bar on top: the build going on (or the last one), what waits to go out, 发布打包 */
.bar{margin:14px 20px 0}
.bar-top{display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.bar .state{flex:1;min-width:260px}
.bar .now{font-weight:600}.bar .sub{font-size:12px;color:var(--muted)}
.s-ok{color:var(--ok)}.s-warn{color:var(--warn)}.s-bad{color:var(--danger)}
/* each step of the build its own bar, timed against the same step of the last builds */
.stages{display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:center;margin-top:8px;font-size:12px}
.stages:empty{display:none}
.stage-name{white-space:nowrap}.stage-time{color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums;text-align:right}
.track{height:8px;border-radius:4px;background:var(--soft);overflow:hidden;position:relative}
.fill{height:100%;border-radius:4px;background:var(--muted);transition:width .8s linear}
.st-done .fill{background:var(--ok)}.st-now .fill{background:var(--warn)}.st-bad .fill{background:var(--danger)}
.st-done .stage-name{color:var(--ok)}.st-now .stage-name{color:var(--warn);font-weight:600}.st-bad .stage-name{color:var(--danger);font-weight:600}.st-wait .stage-name{color:var(--muted)}
.fill.unknown{width:100%!important;opacity:.45;background:repeating-linear-gradient(45deg,var(--warn) 0 6px,transparent 6px 12px);animation:slide 1s linear infinite;background-size:17px 17px}
@keyframes slide{to{background-position:17px 0}}
#history{margin-top:8px;font-size:12px}#history summary{cursor:pointer;color:var(--muted)}
.hist-wrap{overflow:auto;max-height:280px;margin-top:6px}
.hist{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
.hist th,.hist td{padding:3px 8px;border-bottom:1px solid var(--soft);text-align:right;white-space:nowrap}
.hist th:nth-child(2),.hist td:nth-child(2){text-align:left;white-space:normal;min-width:140px}
.hist th{color:var(--muted);font-weight:400;position:sticky;top:0;background:var(--panel)}
.hist td.ok{color:var(--ok)}.hist td.bad{color:var(--danger)}.hist tr.median td{color:var(--muted);font-style:italic}
.chip{white-space:nowrap}.sess{font-family:"Cascadia Mono",Consolas,monospace;font-size:12px;padding:0 4px;border:1px solid var(--soft);border-radius:3px;background:var(--bg)}
.note{margin:8px 0;padding:6px 10px;border-radius:4px;background:var(--bg);font-size:13px}
/* the list, and one issue beside it */
.wrap{display:grid;grid-template-columns:minmax(320px,440px) 1fr;gap:16px;padding:14px 20px 20px;align-items:start}
.wrap.closed{grid-template-columns:minmax(320px,760px)}
.wrap.closed #detail{display:none}
@media (max-width:860px){.wrap,.wrap.closed{grid-template-columns:1fr}.wrap.open #side{display:none}}
.head{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px}
.tabs{display:flex;gap:4px}.tabs .n{margin-left:4px;font-variant-numeric:tabular-nums}.tabs button[aria-pressed=true]{background:var(--ink);color:var(--panel)}
#newForm{margin:6px 0 10px;padding:10px 12px;border:1px solid var(--soft);border-radius:6px;background:var(--bg)}
.thumbs{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
.thumb{position:relative;width:84px;height:64px;border:1px solid var(--soft);border-radius:4px;overflow:hidden;background:var(--bg)}
.thumb img{width:100%;height:100%;object-fit:cover;display:block;cursor:zoom-in}
.thumb button{position:absolute;top:2px;right:2px;padding:0 6px;font-size:12px;background:var(--panel)}
.thumb.up{opacity:.5}
.drop{outline:2px dashed var(--accent);outline-offset:2px}
.list{list-style:none;margin:0;padding:0;max-height:calc(100vh - 230px);overflow:auto}
.list li{display:grid;grid-template-columns:auto 1fr auto;gap:0 8px;align-items:baseline;padding:6px 8px;border-radius:4px;cursor:pointer;border:1px solid transparent}
.list li:hover{background:var(--bg)}.list li[aria-current=true]{border-color:var(--line);background:var(--bg)}
.list li.muted{display:block;cursor:default}
.num{color:var(--muted);font-variant-numeric:tabular-nums}
.t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{grid-column:2/4;font-size:12px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.st{display:inline-block;padding:0 6px;border-radius:3px;border:1px solid currentColor;font-size:12px;line-height:18px;white-space:nowrap}
.st-review{color:var(--warn)}.st-rejected{color:var(--danger)}.st-new{color:var(--accent)}.st-working,.st-asking{color:var(--warn)}.st-fixed,.st-released{color:var(--ok)}.st-stuck{color:var(--danger)}.st-discuss{color:var(--accent)}.st-closed{color:var(--muted)}
#detail .top{display:flex;gap:8px;align-items:center}
#detail .top h2{margin:0;flex:1;min-width:0}
.narrow{display:none}@media (max-width:860px){.narrow{display:inline}.wide{display:none}}
.entry{padding:8px 12px;border-radius:6px;border:1px solid var(--soft);margin:8px 0}
.entry.ai{background:var(--ai)}
.entry.status{border-style:dashed;padding:2px 12px;font-size:12px;color:var(--muted)}
.fold{display:block;width:100%;margin:8px 0;border-style:dashed;color:var(--muted);font-size:12px}
.who{font-size:12px;color:var(--muted);margin-bottom:2px}.who b{color:var(--ink)}
.tag{font-size:11px;border:1px solid var(--accent);color:var(--accent);border-radius:3px;padding:0 4px;margin-left:4px}
.body{white-space:pre-wrap;word-break:break-word}
.msg{margin:8px 0 0;padding:6px 10px;border-radius:4px;background:var(--bg)}.msg.err{color:var(--danger)}
#viewer{position:fixed;inset:0;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;cursor:zoom-out}
#viewer img{max-width:94vw;max-height:94vh;box-shadow:0 4px 24px rgba(0,0,0,.4)}
[hidden]{display:none!important}
</style></head><body>
<header><h1>${escapeHtml(service)} · 问题</h1><span class="muted grow" id="sub">遇到 AMO 的问题写在这里，附上截图；AI 会接着修，修好的攒够了就发测试版。</span><span id="me" class="muted"></span><button type="button" id="logout" hidden>退出</button></header>
<form id="login" class="card" style="max-width:420px;margin:32px auto" hidden><h2>用团队服务器的账号登录</h2><div class="row"><input id="name" placeholder="登录名" autocomplete="username"><input id="pw" type="password" placeholder="密码" autocomplete="current-password"><button class="primary">登录</button></div><div id="loginMsg"></div></form>
<div id="app" hidden>
<div class="card bar" data-testid="issues-release"><div class="bar-top"><div class="state"><div id="buildNow" class="now" data-testid="issues-build"></div><div id="relText" class="sub"></div></div><button type="button" id="relBtn" class="primary" hidden>发布打包</button></div>
<div id="stages" class="stages" data-testid="issues-stages"></div>
<details id="history" data-testid="issues-builds" hidden><summary id="historySum"></summary><div class="hist-wrap"><table class="hist" id="histTable"></table></div></details></div>
<div class="wrap closed" id="wrap">
<section id="side" class="card">
<div class="head"><div class="tabs"><button type="button" data-filter="you" aria-pressed="false" data-testid="issues-tab-you" title="AI 等你回答或卡住了；被打回、要你补充的；你是维护者时还有等你审核的">要你看<span class="n" id="youN"></span></button><button type="button" data-filter="open" aria-pressed="true">进行中</button><button type="button" data-filter="all" aria-pressed="false">全部</button></div><span class="grow"></span><button type="button" id="newToggle" class="primary" data-testid="issues-new-toggle" aria-expanded="false">报问题</button></div>
<form id="newForm" data-testid="issues-new" hidden>
<textarea id="newBody" placeholder="哪里不对：在哪个界面、做了什么、看到了什么。截图直接粘贴（Ctrl+V）或拖进来。Ctrl+Enter 提交。"></textarea>
<div class="thumbs" id="newThumbs"></div>
<div class="row"><select id="newTool"><option value="">哪个工具（可不选）</option></select><input id="newVersion" placeholder="版本（可不填）" size="10"><span class="grow"></span><button type="button" id="newCancel">收起</button><button class="primary" id="newSubmit">提交</button></div>
<div id="newMsg"></div></form>
<ul class="list" id="list" data-testid="issues-list"></ul>
</section>
<section id="detail" class="card" data-testid="issues-detail"></section>
</div>
</div>
<div id="viewer" hidden><img alt=""></div>
<script>
var LABELS = ${labels}, TOOLS = ${tools}, QUIET_MS = ${ISSUE_BUILD_QUIET_MS};
var SYMBOL = { review: "…", rejected: "↩", new: "○", working: "◐", asking: "?", fixed: "✓", released: "✓", stuck: "!", discuss: "◇", closed: "–" };
/** Entries shown of a long issue: the report, and this many of the last. */
var LAST_SHOWN = 3;
var KEY = "amo-issues-key", NAME = "amo-issues-name";
var $ = function (id) { return document.getElementById(id); };
var state = { key: "", name: "", maintainer: false, issues: {}, rev: 0, release: null, selected: null, filter: "open", detail: null, versions: {}, unfolded: {} };
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

// --- new issue: opened on demand above the list
Object.keys(TOOLS).forEach(function (id) { var o = el("option", "", TOOLS[id]); o.value = id; $("newTool").appendChild(o); });
$("newTool").onchange = function () { var v = state.versions[this.value]; if (v) $("newVersion").value = v; };
var newPics = picker($("newForm"), $("newThumbs"), "newMsg");
function showNew(on) { $("newForm").hidden = !on; $("newToggle").setAttribute("aria-expanded", String(on)); $("newToggle").hidden = on; if (on) $("newBody").focus(); }
$("newToggle").onclick = function () { showNew(true); };
$("newCancel").onclick = function () { showNew(false); };
$("newBody").addEventListener("keydown", function (e) { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); $("newForm").requestSubmit(); } });
$("newForm").onsubmit = function (ev) {
  ev.preventDefault();
  if (newPics.busy()) return say("newMsg", "截图还在传，稍等一下", true);
  var body = $("newBody").value.trim(), images = newPics.ids();
  if (!body && !images.length) return say("newMsg", "写一句话或贴一张截图", true);
  $("newSubmit").disabled = true;
  call("POST", "/api/issues", { body: body, images: images, tool: $("newTool").value, version: $("newVersion").value })
    .then(function (j) { $("newBody").value = ""; newPics.clear(); say("newMsg", ""); showNew(false); put(j.issue); select(j.issue.number); })
    .catch(function (e) { say("newMsg", e.message, true); })
    .then(function () { $("newSubmit").disabled = false; });
};

// --- the list
document.querySelectorAll("[data-filter]").forEach(function (b) { b.onclick = function () { state.filter = b.getAttribute("data-filter"); document.querySelectorAll("[data-filter]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); drawList(); }; });
function put(issue) { var had = state.issues[issue.number]; state.issues[issue.number] = Object.assign({}, had || {}, issue); }
function open(i) { return i.status !== "released" && i.status !== "closed"; }
// 要你看 (2026-10-31): what waits for the person — the AI asked, got stuck or suggests talking it over, and has not
// been answered yet.
// 去会话讨论 is the person's own (2026-10-31 晚): not listed.
// 维护者 (2026-11-03): also what waits for a maintainer's review, and one sent back to its author.
function forYou(i) { return ((i.status === "asking" || i.status === "stuck") && !i.awaitsAi) || (state.maintainer && i.status === "review" && i.author !== state.name) || (i.status === "rejected" && i.author === state.name); }
function drawList() {
  var ul = $("list"); ul.innerHTML = "";
  var all = Object.keys(state.issues).map(function (k) { return state.issues[k]; }).sort(function (a, b) { return b.number - a.number; });
  var you = all.filter(forYou).length; $("youN").textContent = you ? String(you) : "";
  var shown = all.filter(function (i) { return state.filter === "all" || (state.filter === "you" ? forYou(i) : open(i)); });
  if (!shown.length) { ul.appendChild(el("li", "muted", !all.length ? "还没有问题。" : state.filter === "you" ? "没有要你看的。" : "没有进行中的问题。")); return; }
  shown.forEach(function (i) {
    var li = el("li"); li.setAttribute("aria-current", String(i.number === state.selected)); li.setAttribute("data-testid", "issue-row");
    li.appendChild(el("span", "num", "#" + i.number)); li.appendChild(el("span", "t", i.title)); li.appendChild(badge(i.status));
    li.appendChild(el("span", "meta", [i.author !== state.name ? i.author + " 提的" : "", i.tool ? TOOLS[i.tool] : "", when(i.updatedAt), i.worker].filter(Boolean).join(" · ")));
    li.onclick = function () { if (state.selected === i.number) close(); else select(i.number); }; ul.appendChild(li);
  });
}

// --- the bar: the build going on (or the last one), what waits to go out, 发布打包
// How long step k of a build took (or has taken so far); null when it did not begin.
function stepTook(b, k, now) {
  var from = b.stepAt[k]; if (from === undefined) return null;
  var to = k < b.step ? b.stepAt[k + 1] : b.endedAt !== null ? b.endedAt : now;
  // A build kept by 0.7.3 has only its start: its steps' times are not known.
  if (to === undefined) return null;
  return Math.max(0, to - from);
}
// What a step usually takes: the median of its last 10 finished runs in the builds before this one.
function expected(builds, name) {
  var took = [];
  for (var i = 1; i < builds.length && took.length < 10; i++) {
    var b = builds[i], k = b.steps.indexOf(name);
    if (k < 0 || b.stepAt[k] === undefined || (k === b.step && !b.ok)) continue;
    var ms = stepTook(b, k, 0); if (ms !== null) took.push(ms);
  }
  if (!took.length) return null;
  took.sort(function (x, y) { return x - y; });
  return took[Math.floor(took.length / 2)];
}
function dur(ms) { if (ms === null || ms === undefined) return "—"; var s = Math.round(ms / 1000); return s < 60 ? s + " 秒" : Math.floor(s / 60) + " 分 " + String(s % 60).padStart(2, "0") + " 秒"; }
function drawRelease() {
  var r = state.release; if (!r) return;
  var builds = r.builds || (r.build ? [r.build] : []), b = builds[0], t = Date.now(), now = $("buildNow"), stages = $("stages");
  now.className = "now"; stages.innerHTML = "";
  var going = !!b && b.endedAt === null, quiet = going && t - b.updatedAt > QUIET_MS;
  if (going) {
    var left = 0, known = true;
    b.steps.forEach(function (s, k) { var e = expected(builds, s); if (e === null) known = false; else if (k > b.step) left += e; else if (k === b.step) left += Math.max(0, e - stepTook(b, k, t)); });
    now.className = "now " + (quiet ? "s-bad" : "s-warn");
    now.textContent = quiet
      ? "! 打包很久没有进展了，可能中断了：" + b.label + "（停在「" + b.steps[b.step] + "」，最后一次消息在 " + when(b.updatedAt) + "）"
      : "◐ 正在打包：" + b.label + " · 第 " + (b.step + 1) + "/" + b.steps.length + " 步「" + b.steps[b.step] + "」 · 已用 " + dur(t - b.startedAt) + (known ? " · 预计还要 " + dur(left) : "");
  } else if (b) {
    now.className = "now " + (b.ok ? "s-ok" : "s-bad");
    now.textContent = b.ok ? "✓ 上次打包完成（" + when(b.endedAt) + "，用了 " + dur(b.endedAt - b.startedAt) + "）：" + (b.message || b.label) : "! 上次打包停在「" + b.steps[b.step] + "」（" + when(b.endedAt) + "）：" + (b.message || b.label);
  } else now.textContent = "现在没有在打包";
  // Each step its own bar: done full, the one going on against what it usually takes, the rest waiting.
  if (b) b.steps.forEach(function (s, k) {
    var e = expected(builds, s), took = stepTook(b, k, t);
    var st = k < b.step || (!going && b.ok) ? "done" : k === b.step ? (going ? "now" : "bad") : "wait";
    var mark = { done: "✓ ", now: "◐ ", bad: "! ", wait: "○ " }[st];
    var row = el("div", "st-" + st); row.style.display = "contents"; row.setAttribute("data-testid", "issues-stage");
    row.appendChild(el("span", "stage-name", mark + s));
    var track = el("div", "track"), fill = el("div", "fill"); track.appendChild(fill); row.appendChild(track);
    var width = st === "done" ? 1 : st === "wait" ? 0 : e ? Math.min(took / e, st === "now" ? 0.97 : 1) : st === "bad" ? 1 : -1;
    if (width < 0) fill.className = "fill unknown"; else fill.style.width = Math.round(width * 100) + "%";
    row.appendChild(el("span", "stage-time", st === "wait" ? (e ? "约 " + dur(e) : "—") : st === "now" ? dur(took) + (e ? " / 约 " + dur(e) : "") : st === "bad" ? "停在这里 · " + dur(took) : dur(took)));
    stages.appendChild(row);
  });
  drawHistory(builds);
  var fixed = Object.keys(state.issues).filter(function (k) { return state.issues[k].status === "fixed"; }).length;
  var parts = ["待发布 " + fixed + " 个"];
  if (r.last) parts.push("上次发布：" + r.last.version + "（" + when(r.last.at) + "）");
  if (r.requestedAt) parts.push("已请求发布（" + when(r.requestedAt) + "），等 Studio 打包…");
  $("relText").textContent = parts.join(" · ");
  $("relBtn").hidden = !state.maintainer;
  $("relBtn").textContent = r.requestedAt ? "取消发布请求" : "发布打包";
  $("relBtn").className = r.requestedAt ? "" : "primary";
}
// 打包记录, like Jenkins' stage view: a row per build, how long each step took; the median on top.
function drawHistory(builds) {
  var box = $("history"), table = $("histTable");
  box.hidden = !builds.length; if (!builds.length) return;
  var names = [];
  builds.forEach(function (b) { b.steps.forEach(function (s) { if (names.indexOf(s) < 0) names.push(s); }); });
  var done = builds.filter(function (b) { return b.endedAt !== null && b.ok; });
  var total = done.map(function (b) { return b.endedAt - b.startedAt; }).sort(function (x, y) { return x - y; });
  $("historySum").textContent = "打包记录（最近 " + builds.length + " 次" + (total.length ? "，成功的一般用 " + dur(total[Math.floor(total.length / 2)]) : "") + "）";
  table.innerHTML = "";
  var head = el("tr"); ["开始", "内容"].concat(names, ["总时长", "结果"]).forEach(function (h) { head.appendChild(el("th", "", h)); }); table.appendChild(head);
  var med = el("tr", "median"); med.appendChild(el("td", "", "中位数")); med.appendChild(el("td", "", "成功的打包"));
  names.forEach(function (s) { med.appendChild(el("td", "", dur(expected([null].concat(builds), s)))); });
  med.appendChild(el("td", "", total.length ? dur(total[Math.floor(total.length / 2)]) : "—")); med.appendChild(el("td", "", "")); table.appendChild(med);
  var t = Date.now();
  builds.forEach(function (b) {
    var tr = el("tr"); tr.setAttribute("data-testid", "issues-build-row");
    tr.appendChild(el("td", "", when(b.startedAt))); tr.appendChild(el("td", "", b.label));
    names.forEach(function (s) { var k = b.steps.indexOf(s); tr.appendChild(el("td", k === b.step && b.endedAt !== null && !b.ok ? "bad" : "", k < 0 ? "" : dur(stepTook(b, k, t)))); });
    tr.appendChild(el("td", "", dur((b.endedAt !== null ? b.endedAt : t) - b.startedAt)));
    var res = b.endedAt === null ? "◐ 进行中" : b.ok ? "✓ 成功" : "! 失败";
    var td = el("td", b.endedAt === null ? "" : b.ok ? "ok" : "bad", res); if (b.message) td.title = b.message; tr.appendChild(td);
    table.appendChild(tr);
  });
}
// While a build goes on its bars move every second.
setInterval(function () { var r = state.release; if (r && r.build && r.build.endedAt === null && !document.hidden) drawRelease(); }, 1000);
$("relBtn").onclick = function () {
  var on = !(state.release && state.release.requestedAt);
  call("POST", "/api/issues/release", { on: on }).then(function (j) { state.release = j.release; drawRelease(); }).catch(function (e) { alert(e.message); });
};

// --- one issue, beside the list (instead of it on a narrow window); 收起 closes it. Its head and entries are drawn
// again when it changes; the comment box below stays (what is being written, the pictures pasted) until another issue
// is chosen.
var commentPics = null, drawnFor = null;
function layout() { $("wrap").className = "wrap " + (state.selected ? "open" : "closed"); }
function select(n) { state.selected = n; layout(); drawList(); call("GET", "/api/issues/" + n).then(function (j) { if (state.selected !== n) return; put(j.issue); state.detail = j.issue; drawDetail(); }).catch(function (e) { alert(e.message); }); }
function close() { state.selected = null; state.detail = null; drawnFor = null; $("detail").innerHTML = ""; layout(); drawList(); }
function drawDetail() {
  var i = state.detail, box = $("detail"); if (!i) return;
  if (drawnFor !== i.number) { box.innerHTML = ""; box.appendChild(el("div", "", "")).id = "entries"; drawForm(i); drawnFor = i.number; }
  var top = $("entries"); top.innerHTML = "";
  var head = el("div", "top");
  var back = el("button", "", ""); back.type = "button"; back.setAttribute("data-testid", "issue-close"); back.appendChild(el("span", "wide", "收起")); back.appendChild(el("span", "narrow", "← 回列表")); back.onclick = close;
  head.appendChild(el("span", "num", "#" + i.number)); head.appendChild(el("h2", "", i.title)); head.appendChild(badge(i.status));
  var act = open(i) ? el("button", "", "不修了") : el("button", "", "重新打开"); act.type = "button"; act.setAttribute("data-testid", "issue-toggle");
  act.onclick = function () { patch(i.number, { status: open(i) ? "closed" : "new" }); };
  // 审核 (2026-11-03): a maintainer lets another's report be worked on, or sends it back with the reason written below.
  var reviewing = state.maintainer && i.status === "review";
  if (reviewing) {
    var ok = el("button", "primary", "确认制作"); ok.type = "button"; ok.setAttribute("data-testid", "issue-approve"); ok.title = "让值守开始处理它";
    ok.onclick = function () { patch(i.number, { status: "new" }); };
    var no = el("button", "", "打回"); no.type = "button"; no.setAttribute("data-testid", "issue-reject"); no.title = "退给 " + i.author + "，原因写在下面的回复框里";
    no.onclick = function () {
      var ta = $("commentText"), why = ta ? ta.value.trim() : "";
      if (!why) { say("commentMsg", "在下面写一句打回的原因，再点「打回」", true); if (ta) ta.focus(); return; }
      call("POST", "/api/issues/" + i.number + "/entries", { body: why, images: commentPics ? commentPics.ids() : [], status: "rejected" })
        .then(function (j) { ta.value = ""; if (commentPics) commentPics.clear(); say("commentMsg", ""); put(j.issue); state.detail = j.issue; drawList(); drawDetail(); })
        .catch(function (e) { say("commentMsg", e.message, true); });
    };
    head.appendChild(ok); head.appendChild(no);
  }
  // 前往讨论 (2026-10-31 晚): the person takes it to the session in Studio; 值守 leaves it alone until 交回值守. A
  // maintainer's (2026-11-03), on an issue let through.
  if (open(i) && state.maintainer && i.status !== "review" && i.status !== "rejected") {
    var talk = el("button", "", i.status === "discuss" ? "交回值守" : "前往讨论"); talk.type = "button"; talk.setAttribute("data-testid", "issue-discuss");
    talk.title = i.status === "discuss" ? "值守接着处理它（当成新问题看）" : "到 Studio 里和处理它的会话讨论；值守不再处理这个问题";
    talk.onclick = function () { patch(i.number, { status: i.status === "discuss" ? "new" : "discuss" }); };
    head.appendChild(talk);
  }
  head.appendChild(act); head.appendChild(back); top.appendChild(head);
  var meta = el("div", "muted"); meta.textContent = [i.author !== state.name ? i.author + " 提的" : "", i.approvedBy && i.approvedBy !== i.author ? i.approvedBy + " 确认制作" : "", i.tool ? TOOLS[i.tool] : "", i.version ? "版本 " + i.version : "", i.fixedIn ? "发布在 " + i.fixedIn : "", i.worker ? "处理：" + i.worker : ""].filter(Boolean).join(" · ");
  if (i.session) meta.appendChild(sessionChip(i.session, meta.textContent ? " · 会话 " : "会话 "));
  if (meta.childNodes.length) top.appendChild(meta);
  if (i.status === "review" || i.status === "rejected") {
    var rn = el("div", "note"); rn.setAttribute("data-testid", "issue-review-note");
    rn.textContent = i.status === "review"
      ? (reviewing ? "这是 " + i.author + " 提的问题，等你审核：「确认制作」后值守才会处理；要打回就在下面写一句原因再点「打回」。" : "等维护者确认后才会开始处理。")
      : (i.author === state.name ? "维护者打回了这个问题，原因在下面。补充说明后发送，就会重新提交审核。" : "已打回，等 " + i.author + " 补充后重新提交。");
    top.appendChild(rn);
  }
  if (i.status === "discuss") {
    var note = el("div", "note"); note.setAttribute("data-testid", "issue-discuss-note");
    note.appendChild(document.createTextNode(i.session ? "已转到会话里讨论，值守不再处理它。在 Studio 顶上的搜索框（Ctrl K）粘贴会话 id 就能打开：" : "已转到会话里讨论，值守不再处理它。还没有 AI 会话处理过这个问题，在 Studio 里新开一个会话讨论吧。"));
    if (i.session) note.appendChild(sessionChip(i.session, ""));
    top.appendChild(note);
  }
  // A long one: the report and the last few; the ones between folded.
  var entries = i.entries || [], hidden = state.unfolded[i.number] ? 0 : Math.max(0, entries.length - 1 - LAST_SHOWN);
  entries.forEach(function (e, k) {
    if (hidden && k === 1) { var more = el("button", "fold", "展开前面 " + hidden + " 条来往"); more.type = "button"; more.setAttribute("data-testid", "issue-unfold"); more.onclick = function () { state.unfolded[i.number] = true; drawDetail(); }; top.appendChild(more); }
    if (hidden && k >= 1 && k <= hidden) return;
    if (e.kind === "status") { top.appendChild(el("div", "entry status", (e.ai ? "AI · " : e.author + " · ") + when(e.at) + " · " + e.body)); return; }
    var d = el("div", "entry" + (e.ai ? " ai" : "")); d.setAttribute("data-testid", "issue-entry");
    var who = el("div", "who"); who.appendChild(el("b", "", e.ai ? "AI" : e.author)); if (e.ai) who.appendChild(el("span", "tag", "代 " + e.author + " 回复")); who.appendChild(document.createTextNode(" · " + when(e.at))); d.appendChild(who);
    if (e.body) d.appendChild(el("div", "body", e.body));
    if (e.images.length) { var th = el("div", "thumbs"); e.images.forEach(function (im) { var t = el("div", "thumb"); var img = document.createElement("img"); img.src = imgUrl(im.id); img.alt = im.name; img.onclick = function () { view(im.id); }; t.appendChild(img); th.appendChild(t); }); d.appendChild(th); }
    top.appendChild(d);
  });
  var ta = $("commentText"); if (ta) ta.placeholder = reviewing ? "要打回的话，在这里写原因（提问题的人会看到），再点上面的「打回」；也可以只回一句。" : i.status === "rejected" && i.author === state.name ? "补充说明（截图可以粘贴或拖进来），发送后重新提交审核。Ctrl+Enter 发送" : i.status === "review" ? "补充点什么…Ctrl+Enter 发送" : i.status === "discuss" ? "在这里记一笔也行；值守不会看，要它接着做就点「交回值守」。" : i.status === "asking" ? "回复 AI：确认、补充或者改主意都行（截图可以粘贴或拖进来）Ctrl+Enter 发送" : open(i) ? "补充点什么…Ctrl+Enter 发送" : "还不对？写在这里，问题会重新打开。";
}
// A session id to copy: the page is plain http, where navigator.clipboard is missing — a hidden box and execCommand then.
function sessionChip(id, lead) {
  var wrap = el("span", "chip"); if (lead) wrap.appendChild(document.createTextNode(lead));
  var code = el("span", "sess", id); code.setAttribute("data-testid", "issue-session"); wrap.appendChild(code);
  var b = el("button", "link", "复制"); b.type = "button"; b.setAttribute("data-testid", "issue-session-copy");
  b.onclick = function () {
    var done = function () { b.textContent = "已复制"; setTimeout(function () { b.textContent = "复制"; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(id).then(done, function () {});
    var box = document.createElement("textarea"); box.value = id; box.style.position = "fixed"; box.style.opacity = "0"; document.body.appendChild(box); box.select();
    try { document.execCommand("copy"); done(); } catch (e) {} document.body.removeChild(box);
  };
  wrap.appendChild(b); return wrap;
}
function drawForm(i) {
  var form = el("form"); form.style.margin = "12px 0 0"; form.setAttribute("data-testid", "issue-comment");
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
// Esc: the picture first, then the open issue (not while writing).
document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape") return;
  if (!$("viewer").hidden) { $("viewer").hidden = true; return; }
  if (state.selected && !(document.activeElement && /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName))) close();
});

// --- keeping up: what changed since the last look, every few seconds while the page is in front
function refresh(all) {
  return call("GET", "/api/issues" + (all || !state.rev ? "" : "?after=" + state.rev)).then(function (j) {
    if (j.me) { state.maintainer = !!j.me.maintainer; $("sub").textContent = state.maintainer ? "你是维护者：能看到所有人的问题，别人提的要你确认制作后值守才处理。" : "遇到 AMO 的问题写在这里，附上截图；维护者确认后 AI 会接着修。这里只有你自己提的问题。"; }
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
