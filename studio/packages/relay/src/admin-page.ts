import { escapeHtml } from "./public.js";

// The team server's admin page (/admin, 2026-10-29, the user: a plain page on the LAN is enough, no AMO login). Its own
// password (set on the service machine: amo-relay admin-password) is asked once and kept for the tab (sessionStorage),
// sent with each call as x-amo-admin. What it does: the members with who is online, rename an account (everywhere its
// name is kept), set a new password, turn an account off or on, set or clear the registration passphrase (hashed, so
// it's never shown — only replaced).

export function adminPage(service: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(service)} · 管理</title>
<style>
:root{--bg:#efede8;--panel:#fbfaf7;--ink:#22201c;--muted:#8d877c;--line:#2a2723;--soft:#d9d5cc;--accent:#23436f;--on:#fbfaf7;--danger:#a3402c;--ok:#3d7a4f}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--panel:#181b1f;--ink:#e6e8eb;--muted:#7c8590;--line:#3a414a;--soft:#2a3038;--accent:#7fb2ff;--on:#0b1626;--danger:#e08a73;--ok:#7cc48f}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.6 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif}
main{max-width:980px;margin:32px auto;padding:0 16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:20px 24px;margin-bottom:16px}
h1{font-size:20px;margin:0 0 2px;font-family:"Noto Serif SC","Songti SC",SimSun,serif}.muted{color:var(--muted)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--soft);vertical-align:middle}
th{font-weight:600;color:var(--muted);font-size:12px;white-space:nowrap}#list{overflow-x:auto}
button{font:inherit;padding:4px 10px;border:1px solid var(--line);border-radius:3px;background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);color:var(--on);border-color:var(--accent)}button.danger{color:var(--danger);border-color:var(--danger)}
input{font:inherit;padding:5px 8px;border:1px solid var(--line);border-radius:3px;background:var(--panel);color:var(--ink)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.acts{display:flex;gap:6px;flex-wrap:wrap}
.on{color:var(--ok)}.off{color:var(--danger)}.msg{margin:10px 0 0;padding:8px 12px;border-radius:4px;background:var(--bg)}.msg.err{color:var(--danger)}
code{background:var(--bg);padding:1px 6px;border-radius:4px;user-select:all}[hidden]{display:none!important}
</style></head><body><main>
<div class="card"><div class="row" style="justify-content:space-between"><h1>${escapeHtml(service)} · 管理</h1><button type="button" id="adminpw" hidden>改管理密码</button></div><p class="muted" id="sub">团队服务器的账号管理。只在局域网里用。</p>
<div class="row" id="reg" hidden><span id="regtext"></span><button type="button" id="setpp"></button><button type="button" id="clearpp" class="danger" hidden>取消口令</button></div>
<form id="login" class="row" hidden><input id="pw" type="password" placeholder="管理密码" autocomplete="current-password"><button class="primary">进入</button></form>
<div id="msg"></div></div>
<div class="card" id="list" hidden><table><thead><tr><th>登录名</th><th>昵称</th><th>负责什么</th><th>状态</th><th>登录中的设备</th><th>最近发言</th><th>注册</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<p class="muted">改登录名：聊天、会话、任务、文件、批注、设备配对里的名字一起改，他已经登录的设备照样能用；之后请他在 AMO 平台的「账号」里退出，用新名字重新登录一次。重设密码和停用会让他所有设备的登录失效。</p></div>
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
      box.appendChild(m.disabled
        ? btn("启用", "", function () { call("POST", "/api/admin/disable", { name: m.name, disabled: false }).then(function () { say("已启用「" + m.name + "」。"); load(); }, function (e) { say(e.message, true); }); })
        : btn("停用", "danger", function () { if (!confirm("停用「" + m.name + "」？他所有设备的登录马上失效，也不能再登录，直到你再启用。聊天记录都留着。")) return; call("POST", "/api/admin/disable", { name: m.name, disabled: true }).then(function () { say("已停用「" + m.name + "」。"); load(); }, function (e) { say(e.message, true); }); }));
      acts.appendChild(box); tr.appendChild(acts); rows.appendChild(tr);
    });
  }, function (e) {
    $("list").hidden = true; $("login").hidden = false; $("adminpw").hidden = true; $("reg").hidden = true;
    if (e.status === 401) { setPw(""); if (pw() !== "") say(e.message, true); }
    say(e.status === 401 && !$("pw").value ? "" : e.message, e.status !== 401 || !!$("pw").value);
  });
}
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
