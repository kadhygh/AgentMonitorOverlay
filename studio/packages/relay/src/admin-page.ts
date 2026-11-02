import { escapeHtml } from "./public.js";

// The team server's admin page (/admin, 2026-10-29, the user: a plain page on the LAN is enough, no AMO login). Its own
// password (set on the service machine: amo-relay admin-password) is asked once and kept for the tab (sessionStorage),
// sent with each call as x-amo-admin. What it does: the members with who is online, rename an account (everywhere its
// name is kept), set a new password, turn an account off or on, set or clear the registration passphrase (hashed, so
// it's never shown — only replaced). 服务器状态 (2026-10-31, monitor.ts): what the relay and the machine use now, and a
// 24-hour curve (a point every 5 minutes), refreshed every minute while the page is open.

export function adminPage(service: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(service)} · 管理</title>
<style>
:root{--s1:#2a78d6;--s2:#eb6834;--bg:#efede8;--panel:#fbfaf7;--ink:#22201c;--muted:#8d877c;--line:#2a2723;--soft:#d9d5cc;--accent:#23436f;--on:#fbfaf7;--danger:#a3402c;--ok:#3d7a4f}
@media (prefers-color-scheme:dark){:root{--s1:#3987e5;--s2:#d95926;--bg:#111316;--panel:#181b1f;--ink:#e6e8eb;--muted:#7c8590;--line:#3a414a;--soft:#2a3038;--accent:#7fb2ff;--on:#0b1626;--danger:#e08a73;--ok:#7cc48f}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif}
main{max-width:980px;margin:32px auto;padding:0 16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:20px 24px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 2px;font-family:"Noto Serif SC","Songti SC",SimSun,serif}.muted{color:var(--muted)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--soft);vertical-align:middle}
th{font-weight:600;color:var(--muted);font-size:12px;white-space:nowrap}#list{overflow-x:auto}
button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:3px;background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);color:var(--on);border-color:var(--accent)}button.danger{color:var(--danger);border-color:var(--danger)}button:disabled{opacity:.45;cursor:default}
input{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:3px;background:var(--panel);color:var(--ink)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.acts{display:flex;gap:6px;flex-wrap:wrap}
.on{color:var(--ok)}.off{color:var(--danger)}.msg{margin:10px 0 0;padding:8px 12px;border-radius:4px;background:var(--bg)}.msg.err{color:var(--danger)}
h2{font-size:16px;margin:0;font-family:"Noto Serif SC","Songti SC",SimSun,serif}h3{font-size:13px;margin:18px 0 6px;color:var(--muted);font-weight:600}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin:14px 0}
.stat{border:1px solid var(--soft);border-radius:6px;padding:8px 12px}.stat .k{font-size:12px;color:var(--muted)}.stat .v{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums}.stat .d{font-size:12px;color:var(--muted)}
.charts{display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:12px}
.chart{position:relative;border:1px solid var(--soft);border-radius:6px;padding:8px 10px 4px}.chart .t{font-size:13px;font-weight:600}.chart svg{display:block;width:100%;height:auto;overflow:visible}
.legend{display:flex;gap:12px;font-size:12px;color:var(--muted)}.legend i{display:inline-block;width:14px;height:2px;vertical-align:middle;margin-right:4px}
.axis{fill:var(--muted);font-size:10px;font-family:system-ui,sans-serif}.grid{stroke:var(--soft);stroke-width:1}.end{fill:var(--ink);font-size:11px;font-family:system-ui,sans-serif}
.tip{position:absolute;pointer-events:none;background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:4px 8px;font-size:12px;white-space:nowrap;z-index:2}.tip b{font-variant-numeric:tabular-nums}.tip i{display:inline-block;width:10px;height:2px;vertical-align:middle;margin-right:4px}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}details{margin-top:12px}summary{cursor:pointer;color:var(--muted)}
code{background:var(--bg);padding:1px 6px;border-radius:4px;user-select:all}[hidden]{display:none!important}
</style></head><body><main>
<div class="card"><div class="row" style="justify-content:space-between"><h1>${escapeHtml(service)} · 管理</h1><button type="button" id="adminpw" hidden>改管理密码</button></div><p class="muted" id="sub">团队服务器的账号管理。只在局域网里用。</p>
<div class="row" id="reg" hidden><span id="regtext"></span><button type="button" id="setpp"></button><button type="button" id="clearpp" class="danger" hidden>取消口令</button></div>
<form id="login" class="row" hidden><input id="pw" type="password" placeholder="管理密码" autocomplete="current-password"><button class="primary">进入</button></form>
<div id="msg"></div></div>
<div class="card" id="list" hidden><table><thead><tr><th>登录名</th><th>昵称</th><th>负责什么</th><th>问题页</th><th>状态</th><th>登录中的设备</th><th>最近发言</th><th>注册</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<p class="muted">改登录名：聊天、会话、任务、文件、批注、设备配对里的名字一起改，他已经登录的设备照样能用；之后请他在 AMO 平台的「账号」里退出，用新名字重新登录一次。重设密码和停用会让他所有设备的登录失效。</p></div>
<div class="card" id="mir" hidden><div class="row" style="justify-content:space-between"><h2>Claude Code 镜像</h2><div class="row"><span class="muted" id="mirat"></span><button type="button" id="mircheck">现在检查</button></div></div>
<p class="muted">定时查 Anthropic 的最新版，有新版就在后台下好压缩包、按官方清单校验，断了会接着下。局域网里的 AMO 平台从这里安装、更新 Claude Code；这里没有的，平台从官方下。</p>
<div class="stats" id="mirstats"></div>
<form id="mirform" class="row"><label><input type="checkbox" id="miron"> 开着</label><label>每 <input id="mirevery" type="number" min="10" max="1440" style="width:80px"> 分钟查一次</label><span class="muted">平台：</span><label><input type="checkbox" id="mirx64"> win32-x64</label><label><input type="checkbox" id="mirarm"> win32-arm64</label><label>保留最新 <input id="mirkeep" type="number" min="1" max="10" style="width:60px"> 版</label><button class="primary">保存设置</button></form>
<h3>服务器上已有的版本</h3><div style="overflow-x:auto"><table><thead><tr><th>版本</th><th>平台</th><th class="n">压缩包</th><th class="n">安装后</th><th>备好于</th></tr></thead><tbody id="mirrows"></tbody></table></div></div>
<div class="card" id="mon" hidden><div class="row" style="justify-content:space-between"><h2>服务器状态</h2><div class="row"><span class="muted" id="monat"></span><button type="button" id="monrefresh">刷新</button></div></div>
<div class="stats" id="stats"></div><div class="charts" id="charts"></div>
<details><summary>表格（每 5 分钟一个点，最近 24 小时）</summary><div style="overflow-x:auto"><table><thead><tr><th>时间</th><th class="n">整机 CPU</th><th class="n">中转 CPU</th><th class="n">负载</th><th class="n">整机内存</th><th class="n">中转内存</th><th class="n">在线人</th><th class="n">设备</th></tr></thead><tbody id="monrows"></tbody></table></div></details>
<h3>这台机器上占内存最多的程序</h3><div style="overflow-x:auto"><table><thead><tr><th>程序</th><th class="n">进程数</th><th class="n">内存</th><th class="n">CPU</th></tr></thead><tbody id="toprows"></tbody></table></div>
<p class="muted">中转 CPU 按整台机器算（和整机 CPU 同一个刻度）；程序的 CPU 是 ps 给的数，按一个核算，可以超过 100%。曲线断开的地方是中转没在运行（重启或停了）。文件夹大小 5 分钟算一次。</p></div>
</main><script>
var KEY = "amo-admin-pw";
var $ = function (id) { return document.getElementById(id); };
function pw() { try { return sessionStorage.getItem(KEY) || ""; } catch (e) { return ""; } }
function setPw(v) { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch (e) {} }
function say(text, err) { $("msg").innerHTML = ""; if (!text) return; var d = document.createElement("div"); d.className = "msg" + (err ? " err" : ""); d.textContent = text; $("msg").appendChild(d); }
function call(method, path, body) {
  return fetch(path, { method: method, headers: { "content-type": "application/json", "x-amo-admin": pw() }, body: body ? JSON.stringify(body) : undefined })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error((j.error && j.error.message) || j.message || ("出错了（" + r.status + "）")); e.status = r.status; throw e; } return j; }); });
}
function when(ms) { if (!ms) return "—"; var d = new Date(ms); return d.toLocaleDateString() + " " + d.toLocaleTimeString().slice(0, 5); }
function cell(text, cls) { var td = document.createElement("td"); td.textContent = text; if (cls) td.className = cls; return td; }
function btn(text, cls, run) { var b = document.createElement("button"); b.type = "button"; b.textContent = text; if (cls) b.className = cls; b.onclick = run; return b; }
function load() {
  return call("GET", "/api/admin/members").then(function (data) {
    loadMon(); loadMir(true);
    $("login").hidden = true; $("list").hidden = false; $("adminpw").hidden = false; $("reg").hidden = false;
    $("sub").textContent = data.members.length + " 个账号";
    $("regtext").textContent = "注册：" + (data.invite ? "要邀请口令" : "不要邀请口令（能连上服务器的人都能注册）");
    $("setpp").textContent = data.invite ? "改邀请口令" : "设邀请口令";
    $("clearpp").hidden = !data.invite;
    var rows = $("rows"); rows.innerHTML = "";
    data.members.forEach(function (m) {
      var tr = document.createElement("tr");
      tr.appendChild(cell(m.name));
      tr.appendChild(cell(m.nick || "—"));
      tr.appendChild(cell(m.role || "—"));
      // 维护者 (2026-11-03, the user): sees everyone's issues on 问题页 and reviews them before 值守 works on them.
      var mt = cell(m.maintainer ? "✓ 维护者" : "—", m.maintainer ? "on" : "muted"); mt.setAttribute("data-testid", "admin-maintainer"); tr.appendChild(mt);
      tr.appendChild(cell(m.disabled ? "! 已停用" : m.online ? "● 在线" : "○ 离线", m.disabled ? "off" : m.online ? "on" : "muted"));
      tr.appendChild(cell(String(m.logins)));
      tr.appendChild(cell(when(m.lastMessageAt)));
      tr.appendChild(cell(when(m.createdAt)));
      var acts = document.createElement("td"); var box = document.createElement("div"); box.className = "acts";
      box.appendChild(btn("改登录名", "", function () {
        var to = prompt("把「" + m.name + "」改成：", m.name); if (!to || to.trim() === m.name) return;
        call("POST", "/api/admin/rename", { from: m.name, to: to.trim() }).then(function (r) { say("已把「" + r.from + "」改成「" + r.to + "」。请他在 AMO 平台的「账号」里退出，用「" + r.to + "」重新登录。"); load(); }, function (e) { say(e.message, true); });
      }));
      box.appendChild(btn("重设密码", "", function () {
        var given = prompt("「" + m.name + "」的新密码（留空就随机生成一个）：", ""); if (given === null) return;
        call("POST", "/api/admin/password", { name: m.name, password: given }).then(function (r) { say("「" + r.name + "」的新密码：" + r.password + "（他所有设备都要重新登录）"); load(); }, function (e) { say(e.message, true); });
      }));
      box.appendChild(btn(m.maintainer ? "取消维护者" : "设为维护者", "", function () {
        call("POST", "/api/admin/maintainer", { name: m.name, maintainer: !m.maintainer }).then(function () { say(m.maintainer ? "「" + m.name + "」不再是维护者：问题页上只看得到自己的问题，提的问题要维护者审核。" : "「" + m.name + "」是维护者了：问题页上看得到所有人的问题，别人提的要他确认制作后值守才处理。"); load(); }, function (e) { say(e.message, true); });
      }));
      box.appendChild(m.disabled
        ? btn("启用", "", function () { call("POST", "/api/admin/disable", { name: m.name, disabled: false }).then(function () { say("已启用「" + m.name + "」。"); load(); }, function (e) { say(e.message, true); }); })
        : btn("停用", "danger", function () { if (!confirm("停用「" + m.name + "」？他所有设备的登录马上失效，也不能再登录，直到你再启用。聊天记录都留着。")) return; call("POST", "/api/admin/disable", { name: m.name, disabled: true }).then(function () { say("已停用「" + m.name + "」。"); load(); }, function (e) { say(e.message, true); }); }));
      acts.appendChild(box); tr.appendChild(acts); rows.appendChild(tr);
    });
  }, function (e) {
    $("list").hidden = true; $("mon").hidden = true; $("mir").hidden = true; $("login").hidden = false; $("adminpw").hidden = true; $("reg").hidden = true;
    if (e.status === 401) { setPw(""); if (pw() !== "") say(e.message, true); }
    say(e.status === 401 && !$("pw").value ? "" : e.message, e.status !== 401 || !!$("pw").value);
  });
}
// ---- 服务器状态
var SVGNS = "http://www.w3.org/2000/svg";
function bytes(n) { if (n == null) return "—"; var u = ["B", "KB", "MB", "GB", "TB"], i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(n < 10 ? 2 : 1) : String(n)) + " " + u[i]; }
function span(sec) { var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60); return d ? d + " 天 " + h + " 小时" : h ? h + " 小时 " + m + " 分" : m + " 分"; }
function hm(t) { var d = new Date(t); return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2); }
function nice(v) { if (!(v > 0)) return 1; var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10)), f = [1, 2, 2.5, 5, 10]; for (var i = 0; i < f.length; i++) if (f[i] * e >= v) return f[i] * e; return 10 * e; }
function el(tag, attrs, parent) { var e = document.createElementNS(SVGNS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
function stat(k, v, d, into) { var s = document.createElement("div"); s.className = "stat"; [["k", k], ["v", v], ["d", d]].forEach(function (x) { var e = document.createElement("div"); e.className = x[0]; e.textContent = x[1]; s.appendChild(e); }); $(into || "stats").appendChild(s); }
// One chart: one y axis from 0, the last 24 hours across, a line per series broken where the relay wasn't running.
function chart(title, series, points, opt) {
  var box = document.createElement("div"); box.className = "chart";
  var head = document.createElement("div"); head.className = "row"; head.style.justifyContent = "space-between";
  var t = document.createElement("span"); t.className = "t"; t.textContent = title; head.appendChild(t);
  if (series.length > 1) { var lg = document.createElement("span"); lg.className = "legend"; series.forEach(function (s) { var x = document.createElement("span"); var k = document.createElement("i"); k.style.background = s.color; x.appendChild(k); x.appendChild(document.createTextNode(s.label)); lg.appendChild(x); }); head.appendChild(lg); }
  box.appendChild(head);
  var W = 460, H = 150, L = 40, R = 64, T = 10, B = 20, now = opt.now, from = now - 24 * 3600000;
  var max = opt.max || nice(Math.max.apply(null, [opt.min || 0].concat(points.map(function (p) { return Math.max.apply(null, series.map(function (s) { return s.get(p); })); }))));
  if (opt.whole) max = Math.ceil(max / 2) * 2;
  var X = function (tt) { return L + (tt - from) / (now - from) * (W - L - R); }, Y = function (v) { return T + (1 - v / max) * (H - T - B); };
  var svg = el("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": title }, box);
  [0, 0.5, 1].forEach(function (f) { var v = max * f; el("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v), "class": "grid" }, svg); el("text", { x: L - 6, y: Y(v) + 3, "text-anchor": "end", "class": "axis" }, svg).textContent = opt.fmt(v); });
  for (var h = 24; h >= 0; h -= 6) { var tx = now - h * 3600000; el("text", { x: X(tx), y: H - 4, "text-anchor": h === 24 ? "start" : h === 0 ? "end" : "middle", "class": "axis" }, svg).textContent = h ? hm(tx) : "现在"; }
  series.forEach(function (s) {
    var runs = [], cur = [];
    points.forEach(function (p, i) { if (i && p.t - points[i - 1].t > opt.gap) { runs.push(cur); cur = []; } cur.push(p); });
    if (cur.length) runs.push(cur);
    runs.forEach(function (run) {
      if (run.length === 1) el("circle", { cx: X(run[0].t), cy: Y(s.get(run[0])), r: 2.5, fill: s.color }, svg);
      else el("polyline", { points: run.map(function (p) { return X(p.t).toFixed(1) + "," + Y(s.get(p)).toFixed(1); }).join(" "), fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
    });
    var last = points[points.length - 1];
    if (last) { el("circle", { cx: X(last.t), cy: Y(s.get(last)), r: 4, fill: s.color, stroke: "var(--panel)", "stroke-width": 2 }, svg); s.endY = Y(s.get(last)); s.endText = opt.fmt(s.get(last)) + (series.length > 1 ? " " + s.label : ""); }
  });
  // Direct labels at the right end, pushed apart when two would overlap.
  var ends = series.filter(function (s) { return s.endText; }).sort(function (a, b) { return a.endY - b.endY; });
  for (var i = 1; i < ends.length; i++) if (ends[i].endY - ends[i - 1].endY < 12) ends[i].endY = ends[i - 1].endY + 12;
  ends.forEach(function (s) { el("text", { x: W - R + 8, y: s.endY + 4, "class": "end" }, svg).textContent = s.endText; });
  // Hover: a hairline at the nearest point, every series' value in one tooltip.
  var hair = el("line", { y1: T, y2: H - B, stroke: "var(--muted)", "stroke-width": 1, visibility: "hidden" }, svg);
  var tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; box.appendChild(tip);
  var hit = el("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" }, svg);
  hit.addEventListener("pointermove", function (ev) {
    if (!points.length) return;
    var r = svg.getBoundingClientRect(), tt = from + ((ev.clientX - r.left) / r.width * W - L) / (W - L - R) * (now - from), best = points[0];
    points.forEach(function (p) { if (Math.abs(p.t - tt) < Math.abs(best.t - tt)) best = p; });
    hair.setAttribute("x1", X(best.t)); hair.setAttribute("x2", X(best.t)); hair.setAttribute("visibility", "visible");
    tip.innerHTML = ""; var at = document.createElement("div"); at.className = "muted"; at.textContent = hm(best.t); tip.appendChild(at);
    series.forEach(function (s) { var row = document.createElement("div"); var k = document.createElement("i"); k.style.background = s.color; var b = document.createElement("b"); b.textContent = opt.fmt(s.get(best)); row.appendChild(k); row.appendChild(b); row.appendChild(document.createTextNode(" " + s.label)); tip.appendChild(row); });
    tip.hidden = false; var px = X(best.t) / W * r.width + 10; tip.style.left = Math.max(4, Math.min(px, box.clientWidth - tip.offsetWidth - 4)) + "px"; tip.style.top = "28px";
  });
  hit.addEventListener("pointerleave", function () { hair.setAttribute("visibility", "hidden"); tip.hidden = true; });
  $("charts").appendChild(box);
}
var monTimer = null;
function loadMon() {
  return call("GET", "/api/admin/monitor").then(function (m) {
    var n = m.now, p = n.point, GB = 1073741824, MB = 1048576, hist = m.history;
    $("mon").hidden = false; $("monat").textContent = "更新于 " + hm(p.t);
    $("stats").innerHTML = "";
    stat("中转进程", bytes(p.rss), "CPU " + p.relayCpu + "%（占整机） · 已运行 " + span((p.t - n.startedAt) / 1000));
    stat("在线", p.people + " 人 · " + p.devices + " 台设备", "开着客户端的账号；远程通道上的设备");
    stat("整机 CPU", p.cpu + "%", "负载 " + p.load + " · " + n.cores + " 核");
    stat("整机内存", bytes(p.memUsed) + " / " + bytes(p.memTotal), "已用 " + Math.round(p.memUsed / p.memTotal * 100) + "%（可回收的缓存算空闲）");
    stat("磁盘", n.disk ? "剩余 " + bytes(n.disk.free) : "—", n.disk ? "共 " + bytes(n.disk.total) + " · 已用 " + Math.round((1 - n.disk.free / n.disk.total) * 100) + "%" : "");
    stat("中转的文件夹", n.dirs.map(function (d) { return d.label + " " + bytes(d.bytes); }).join(" · ") || "—", "机器已开 " + span(n.machineUptime) + " · Node " + n.node);
    $("charts").innerHTML = "";
    var gap = m.everyMs * 2.5;
    var pct = function (v) { return (Math.round(v * 10) / 10) + "%"; };
    chart("CPU（占整机 %）", [{ label: "整机", color: "var(--s1)", get: function (x) { return x.cpu; } }, { label: "中转", color: "var(--s2)", get: function (x) { return x.relayCpu; } }], hist, { now: p.t, gap: gap, min: 10, fmt: pct });
    chart("整机内存（GB）", [{ label: "已用", color: "var(--s1)", get: function (x) { return x.memUsed / GB; } }], hist, { now: p.t, gap: gap, max: p.memTotal / GB, fmt: function (v) { return v ? v.toFixed(v < 10 ? 1 : 0) : "0"; } });
    chart("中转进程内存（MB）", [{ label: "中转", color: "var(--s1)", get: function (x) { return x.rss / MB; } }], hist, { now: p.t, gap: gap, min: 50, fmt: function (v) { return String(Math.round(v)); } });
    chart("在线", [{ label: "人", color: "var(--s1)", get: function (x) { return x.people; } }, { label: "设备", color: "var(--s2)", get: function (x) { return x.devices; } }], hist, { now: p.t, gap: gap, min: 4, whole: true, fmt: function (v) { return String(Math.round(v)); } });
    var rows = $("monrows"); rows.innerHTML = "";
    hist.slice().reverse().forEach(function (x) {
      var tr = document.createElement("tr"); tr.appendChild(cell(when(x.t)));
      [pct(x.cpu), pct(x.relayCpu), String(x.load), bytes(x.memUsed), bytes(x.rss), String(x.people), String(x.devices)].forEach(function (v) { tr.appendChild(cell(v, "n")); });
      rows.appendChild(tr);
    });
    if (!hist.length) { var tr = document.createElement("tr"); var td = cell("还没有点：服务启动 5 分钟后记第一个。", "muted"); td.colSpan = 8; tr.appendChild(td); rows.appendChild(tr); }
    var top = $("toprows"); top.innerHTML = "";
    n.top.forEach(function (x) { var tr = document.createElement("tr"); tr.appendChild(cell(x.name)); tr.appendChild(cell(String(x.count), "n")); tr.appendChild(cell(bytes(x.rss), "n")); tr.appendChild(cell(Math.round(x.cpu * 10) / 10 + "%", "n")); top.appendChild(tr); });
    if (!n.top.length) { var tr2 = document.createElement("tr"); var td2 = cell("这台机器上没有 ps，看不到。", "muted"); td2.colSpan = 4; tr2.appendChild(td2); top.appendChild(tr2); }
    if (!monTimer) monTimer = setInterval(function () { if (!document.hidden && !$("mon").hidden) loadMon(); }, 60000);
  }, function () { $("mon").hidden = true; });
}
$("monrefresh").onclick = function () { loadMon(); };
// ---- Claude Code 镜像 (mirror.ts, 2026-11-03): its settings, how it stands, the versions here; every 3 s while it works,
// every minute otherwise.
var mirTimer = null, mirBusy = false;
var MIR_STATE = { off: "○ 关着", idle: "✓ 空闲", checking: "◐ 正在检查", downloading: "◐ 正在下载", verifying: "◐ 正在校验", waiting: "! 下载断了，稍后接着下" };
function loadMir(fillForm) {
  return call("GET", "/api/admin/mirror").then(function (m) {
    var s = m.status, st = m.settings, p = s.progress, newest = m.versions[0];
    $("mir").hidden = false;
    $("mirat").textContent = "上次检查 " + (s.checkedAt ? when(Date.parse(s.checkedAt)) : "—") + (s.nextCheckAt ? " · 下次 " + when(Date.parse(s.nextCheckAt)) : "");
    $("mirstats").innerHTML = "";
    stat("状态", MIR_STATE[s.state] || s.state, s.error ? "! " + s.error : "", "mirstats");
    stat("官方最新", s.official || "—", "Anthropic 的 latest 通道", "mirstats");
    stat("服务器上最新", newest ? newest.version : "还没有", newest ? (newest.version === s.official ? "和官方一样" : "官方更新的那版还没备好") : "", "mirstats");
    if (p) stat("正在下 " + p.version + " " + p.platform, bytes(p.done) + (p.total ? " / " + bytes(p.total) : ""), (p.total ? Math.floor(p.done / p.total * 100) + "% · " : "") + bytes(p.bytesPerSec) + "/s", "mirstats");
    if (fillForm) { $("miron").checked = st.enabled; $("mirevery").value = st.everyMinutes; $("mirx64").checked = st.platforms.indexOf("win32-x64") >= 0; $("mirarm").checked = st.platforms.indexOf("win32-arm64") >= 0; $("mirkeep").value = st.keep; }
    $("mircheck").disabled = !st.enabled || ["checking", "downloading", "verifying", "waiting"].indexOf(s.state) >= 0;
    var rows = $("mirrows"); rows.innerHTML = "";
    m.versions.forEach(function (v) {
      Object.keys(v.platforms).forEach(function (pf) {
        var f = v.platforms[pf], tr = document.createElement("tr");
        [v.version, pf].forEach(function (x) { tr.appendChild(cell(x)); });
        tr.appendChild(cell(bytes(f.size), "n")); tr.appendChild(cell(bytes(f.exeSize), "n")); tr.appendChild(cell(when(Date.parse(v.readyAt))));
        rows.appendChild(tr);
      });
    });
    if (!m.versions.length) { var tr = document.createElement("tr"); var td = cell(st.enabled ? "还没有：第一次检查在服务启动半分钟后，也可以点「现在检查」。" : "镜像关着。", "muted"); td.colSpan = 5; tr.appendChild(td); rows.appendChild(tr); }
    var busy = s.state !== "idle" && s.state !== "off";
    if (!mirTimer || busy !== mirBusy) { clearInterval(mirTimer); mirBusy = busy; mirTimer = setInterval(function () { if (!document.hidden && !$("mir").hidden) loadMir(false); }, busy ? 3000 : 60000); }
  }, function () { $("mir").hidden = true; });
}
$("mircheck").onclick = function () { call("POST", "/api/admin/mirror/check").then(function () { say("开始检查了。"); loadMir(false); }, function (e) { say(e.message, true); }); };
$("mirform").onsubmit = function (ev) {
  ev.preventDefault();
  var platforms = []; if ($("mirx64").checked) platforms.push("win32-x64"); if ($("mirarm").checked) platforms.push("win32-arm64");
  call("POST", "/api/admin/mirror/settings", { enabled: $("miron").checked, everyMinutes: Number($("mirevery").value), platforms: platforms, keep: Number($("mirkeep").value) })
    .then(function () { say("镜像的设置已保存，马上生效。"); loadMir(true); }, function (e) { say(e.message, true); });
};
$("adminpw").onclick = function () {
  var a = prompt("新的管理密码：", ""); if (!a) return;
  var b = prompt("再输一遍新的管理密码：", ""); if (b === null) return;
  if (a !== b) { say("两次输的不一样，管理密码没有改。", true); return; }
  call("POST", "/api/admin/admin-password", { password: a }).then(function () { setPw(a); say("管理密码已改好，下次用新密码进入。"); }, function (e) { say(e.message, true); });
};
$("setpp").onclick = function () {
  var v = prompt("新的邀请口令（至少 4 位）。新注册的人要在 AMO 平台的注册页填它。现在的口令看不到，只能换一个新的：", ""); if (v === null) return;
  if (!v.trim()) { say("口令是空的，没有改。", true); return; }
  call("POST", "/api/admin/passphrase", { passphrase: v }).then(function () { say("邀请口令已设好：新注册的人要填它。已经有的账号不受影响。"); load(); }, function (e) { say(e.message, true); });
};
$("clearpp").onclick = function () {
  if (!confirm("取消邀请口令？之后能连上服务器的人都能注册。已经有的账号不受影响。")) return;
  call("POST", "/api/admin/passphrase", { passphrase: "" }).then(function (r) { say(r.invite ? "页面上设的口令已取消，但服务启动时带了 --passphrase，注册仍要那个口令。" : "邀请口令已取消：能连上服务器的人都能注册。"); load(); }, function (e) { say(e.message, true); });
};
$("login").onsubmit =function (ev) { ev.preventDefault(); setPw($("pw").value); load(); };
if (pw()) load(); else { $("login").hidden = false; call("GET", "/api/admin/members").catch(function (e) { if (e.status === 403) say(e.message, true); }); }
</script></body></html>`;
}
