// userlayer 各表达共用的读写层（2026-11-01 原型）。
// 读 <script id="amo-data"> 里的 datalayer；人的操作记在 localStorage，所有表达共用一份，
// 所以在一种表达里回答了，换一种表达打开也能看到——这正是「表现随便换」要验证的。
window.AMO = (() => {
  const raw = JSON.parse(document.getElementById("amo-data").textContent);
  const KEY = "amo-userlayer:" + raw.context.id;
  const NOW = raw.now || "2026-11-01T08:30:00+08:00"; // 假数据的「现在」，让各表达的相对时间一致
  const subs = [];
  // 人的操作按假数据的「现在」往后排（第 n 次操作 = NOW + n 分钟），写成和数据一样的 +08:00 格式，
  // 这样字符串比较、排序、「上次以来」都和假数据对得上（B、C 组 11-01 的建议）
  function fakeNow(n) {
    const d = new Date(new Date(NOW).getTime() + n * 60000 + 8 * 3600000);
    return d.toISOString().slice(0, 19) + "+08:00";
  }

  const TYPE = {
    decision: { label: "决定", hint: "要你拍板" },
    question: { label: "问题", hint: "要你回答" },
    bug: { label: "bug", hint: "出错的地方" },
    finding: { label: "发现", hint: "值得注意" },
    task: { label: "事项", hint: "要做的事" },
    conclusion: { label: "结论", hint: "已经定了" },
    milestone: { label: "节点", hint: "发布、开工、交接" },
  };
  // 状态不能只靠颜色：每个都带符号和文字
  const STATUS = {
    needs_you: { label: "等你", sym: "!", color: "var(--accent-fill)", soft: "var(--accent-soft)" },
    working: { label: "进行中", sym: "◐", color: "var(--s2)", soft: "var(--surface-2)" },
    waiting: { label: "等别人", sym: "○", color: "var(--warn)", soft: "var(--warn-soft)" },
    settled: { label: "已定", sym: "✓", color: "var(--good)", soft: "var(--good-soft)" },
    parked: { label: "搁置", sym: "–", color: "var(--neutral)", soft: "var(--surface-2)" },
  };
  const REL = {
    depends: { out: "要等", in: "被它卡住的" },
    affects: { out: "会影响", in: "受它影响" },
    answers: { out: "回答了", in: "被回答" },
    supersedes: { out: "取代了", in: "被取代" },
    part_of: { out: "属于", in: "包含" },
  };
  const EVIDENCE = { file: "文件", commit: "提交", session: "会话", url: "网址", log: "记录" };
  const IMPORTANCE = { high: 3, normal: 2, low: 1 };

  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { ops: [], seenAt: null }; } catch { return { ops: [], seenAt: null }; } };
  const save = () => localStorage.setItem(KEY, JSON.stringify(state));
  let state = load();
  let data;

  function build() {
    data = JSON.parse(JSON.stringify(raw));
    // 0.2 的条目只写 at：补齐 0.1 的时间和重要程度字段，各表达不用分两套
    for (const i of data.items) { i.createdAt ||= i.at; i.updatedAt ||= i.at; i.importance ||= "normal"; i.evidence ||= []; }
    data.events ||= []; data.areas ||= []; data.links ||= [];
    if (state.seenAt) data.viewer.lastSeenAt = state.seenAt;
    for (const op of state.ops) applyOp(op);
  }
  function applyOp(op) {
    const it = data.items.find((i) => i.id === op.item);
    if (!it) return;
    const ev = { at: op.at, item: it.id, actor: "human", kind: op.kind, text: "" };
    if (op.kind === "answered") {
      const opt = it.ask.options.find((o) => o.id === op.option);
      it.ask.answer = { option: op.option, note: op.note || "", at: op.at };
      it.status = "working";
      it.owner = it.source;
      // 球交回提问的 agent：它的状态和在做的事跟着变
      const ag = data.agents.find((a) => a.id === it.source);
      if (ag) { ag.status = "running"; ag.item = it.id; ag.doing = `按你选的「${opt ? opt.label : op.option}」处理 #${it.num}`; }
      ev.text = `你选了「${opt ? opt.label : op.option}」${op.note ? "：" + op.note : ""}，交回${ownerName(it.source)}`;
    } else if (op.kind === "parked") {
      it.status = "parked"; it.owner = "human";
      ev.kind = "status"; ev.text = "你搁置了" + (op.note ? "：" + op.note : "");
    } else if (op.kind === "reopened") {
      const orig = raw.items.find((i) => i.id === it.id);
      it.status = orig.status === "parked" ? "needs_you" : orig.status; it.owner = orig.status === "parked" ? "human" : orig.owner;
      if (it.ask && orig.ask && !orig.ask.answer) { delete it.ask.answer; it.status = "needs_you"; it.owner = "human"; }
      ev.kind = "status"; ev.text = "你重新打开了";
    } else if (op.kind === "comment") {
      ev.text = "你批注：" + op.note;
    }
    it.updatedAt = op.at;
    data.events.push(ev);
  }
  function commit(op) {
    op.at = fakeNow(state.ops.length + 1);
    state.ops.push(op); save(); build(); emit();
  }
  const emit = () => subs.forEach((f) => f(data));

  // ---------- 查询 ----------
  const items = (pred) => data.items.filter(pred || (() => true));
  const item = (key) => data.items.find((i) => i.id === key || i.num === key || "#" + i.num === key);
  const agent = (id) => data.agents.find((a) => a.id === id);
  const area = (id) => data.areas.find((a) => a.id === id);
  function ownerName(owner) {
    if (!owner) return "";
    if (owner === "human") return "你";
    if (owner.startsWith("team:")) return owner.slice(5);
    const a = agent(owner); return a ? a.name : owner;
  }
  // 站在当前这一条说话：「要先等 #5」「#10 在等这条」，比 label 的「被它卡住的」好懂（A 组 11-01 的建议）
  const SAY = {
    depends: { out: (n) => `要先等 #${n}`, in: (n) => `#${n} 在等这条` },
    affects: { out: (n) => `会影响 #${n}`, in: (n) => `#${n} 会影响这条` },
    answers: { out: (n) => `回答了 #${n}`, in: (n) => `#${n} 回答了这条` },
    supersedes: { out: (n) => `取代了 #${n}`, in: (n) => `#${n} 取代了这条` },
    part_of: { out: (n) => `属于 #${n}`, in: (n) => `#${n} 是这条的一部分` },
  };
  function links(id) {
    return {
      out: data.links.filter((l) => l.from === id).map((l) => ({ ...l, item: item(l.to), label: REL[l.rel].out, say: SAY[l.rel].out(item(l.to).num) })),
      in: data.links.filter((l) => l.to === id).map((l) => ({ ...l, item: item(l.from), label: REL[l.rel].in, say: SAY[l.rel].in(item(l.from).num) })),
    };
  }
  const lastSeen = () => data.viewer.lastSeenAt;
  // 「上次以来」只算 agent 那边的变化，人自己的操作不算
  const isNew = (it) => { const r = raw.items.find((i) => i.id === it.id) || it; return (r.updatedAt || r.at) > lastSeen(); };
  const changesSince = (t) => data.events.filter((e) => e.at > (t || lastSeen())).sort((a, b) => a.at.localeCompare(b.at));
  const byWeight = (a, b) => IMPORTANCE[b.importance] - IMPORTANCE[a.importance] || a.createdAt.localeCompare(b.createdAt);
  const needsYou = () => items((i) => i.status === "needs_you").sort(byWeight);
  function counts() {
    const c = { total: data.items.length };
    for (const s of Object.keys(STATUS)) c[s] = data.items.filter((i) => i.status === s).length;
    return c;
  }

  // ---------- 文字 ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function inline(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/#(\d+)/g, '<a href="#" class="amo-ref" data-num="$1">#$1</a>');
  }
  function md(text) {
    if (!text) return "";
    return text.split(/\n{2,}/).map((p) => {
      const lines = p.split("\n");
      if (lines.every((l) => /^\s*[-*] /.test(l))) return "<ul>" + lines.map((l) => "<li>" + inline(l.replace(/^\s*[-*] /, "")) + "</li>").join("") + "</ul>";
      return "<p>" + lines.map(inline).join("<br>") + "</p>";
    }).join("");
  }
  function fmtTime(iso) {
    const d = new Date(iso), now = new Date(NOW);
    const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
    const day = (x) => x.toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" });
    if (day(d) === day(now)) return "今天 " + hm;
    if (day(new Date(d.getTime() + 864e5)) === day(now)) return "昨天 " + hm;
    return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" }) + " " + hm;
  }
  function ago(iso) {
    const m = Math.round((new Date(NOW) - new Date(iso)) / 60000);
    if (m < 1) return "刚才"; if (m < 60) return m + " 分钟前";
    const h = Math.round(m / 60); return h < 24 ? h + " 小时前" : Math.round(h / 24) + " 天前";
  }

  // ---------- 外观 ----------
  function applyTheme() { const t = localStorage.getItem("amo-userlayer:theme"); if (t) document.documentElement.dataset.theme = t; }
  function toggleTheme() {
    const r = document.documentElement;
    const dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    r.dataset.theme = dark ? "light" : "dark";
    localStorage.setItem("amo-userlayer:theme", r.dataset.theme);
  }
  function toast(msg) {
    let el = document.getElementById("amo-toast");
    if (!el) {
      el = document.createElement("div"); el.id = "amo-toast";
      el.style.cssText = "position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--tip-bg);color:var(--tip-fg);padding:9px 16px;border-radius:10px;font:13.5px var(--sans);z-index:99;opacity:0;transition:opacity .2s;pointer-events:none";
      document.body.appendChild(el);
    }
    el.textContent = msg; el.style.opacity = 1;
    clearTimeout(el._t); el._t = setTimeout(() => (el.style.opacity = 0), 2200);
  }

  applyTheme();
  build();
  addEventListener("storage", (e) => { if (e.key === KEY) { state = load(); build(); emit(); } });

  return {
    raw, get data() { return data; }, NOW, TYPE, STATUS, REL, EVIDENCE, IMPORTANCE,
    items, item, agent, area, ownerName, links, lastSeen, isNew, changesSince, needsYou, counts, byWeight,
    esc, md, inline, fmtTime, ago, toggleTheme, toast,
    now: () => fakeNow(state.ops.length),
    // 各表达自己的布局（纸摆在哪、区画在哪），按表达分开存，人摆过的位置不会被别的表达改掉
    layout: (view, value) => { const k = "amo-userlayer:layout:" + view; if (value === undefined) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } } localStorage.setItem(k, JSON.stringify(value)); },
    on: (f) => { subs.push(f); return () => subs.splice(subs.indexOf(f), 1); },
    // 人的操作：都写成事件，球交回提问的 agent
    answer: (id, option, note) => { commit({ kind: "answered", item: id, option, note }); toast("已发回" + ownerName(item(id).source)); },
    park: (id, note) => { commit({ kind: "parked", item: id, note }); toast("已搁置 #" + item(id).num); },
    reopen: (id) => { commit({ kind: "reopened", item: id }); toast("已重新打开 #" + item(id).num); },
    comment: (id, note) => { commit({ kind: "comment", item: id, note }); toast("批注已记下，整理员会归档"); },
    markSeen: () => { state.seenAt = fakeNow(state.ops.length + 1); save(); build(); emit(); toast("已标为看过"); },
    reset: () => { state = { ops: [], seenAt: null }; save(); build(); emit(); toast("已恢复成初始假数据"); },
  };
})();
