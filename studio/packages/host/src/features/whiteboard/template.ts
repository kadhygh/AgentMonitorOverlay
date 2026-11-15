// 白板的页面 (2026-11-16, plans/whiteboard.md). A board is drawn by a page: this one, unless the session's AI gave its own
// (whiteboard_view — the user: ai 通过快速调整 html 的方式，直接展示这个 board 里的相关内容). Either is only the inside of <body>;
// the workbench puts it in a frame of its own (ui/src/whiteboard/frame.ts: no network, no way to the workbench's page) with:
//
//   - a body with a little room around it (padding; the page may set its own);
//   - CSS variables that follow Studio's theme: --bg --surface --surface-2 --text --text-2 --text-3 --line --accent
//     --ok --warn --radius --sans --serif --mono;
//   - window.BOARD = { rev, seenRev, nodes: [{ id, kind, title, body, status, group, after, from, rev, at }],
//     notes: [...], kinds: { goal: "目标", … }, statuses: { open: "开着", … } };
//   - a call of window.renderBoard(BOARD) once the page is loaded and again each time the board changed.
//
// A page marks what stands for a node with data-node="<id>": those are what the person can select and pin a note on;
// the frame draws the notes' pins itself. Anywhere else the person can pin a note at the place.
//
// Kept free of backticks and of ${ so it can sit in a template literal as it is.

export const WHITEBOARD_VIEW_CONTRACT =
  "Only the inside of <body> (style, markup, script; no network: nothing is loaded from outside). Studio gives the page CSS variables that follow its theme (--bg --surface --surface-2 --text --text-2 --text-3 --line --accent --ok --warn --radius --sans --serif --mono), sets window.BOARD = { rev, seenRev, nodes: [{ id, kind, title, body, status, group, after, from, rev }], notes, kinds, statuses } (kinds and statuses: id → Chinese label), and calls window.renderBoard(BOARD) after load and after every change of the board: define it and draw from the data, so the page does not need rewriting when a node changes. Give each node's element data-node=\"<id>\": that is what the person can select and pin a note on (Studio draws the pins).";

export const DEFAULT_WHITEBOARD_VIEW = String.raw`<style>
  .b-empty { color: var(--text-3); font: 13px/1.7 var(--sans); padding: 48px 0; text-align: center; }
  .b-cols { display: flex; gap: 24px; align-items: flex-start; position: relative; min-width: min-content; }
  .b-col { flex: 1 1 260px; min-width: 228px; max-width: 340px; display: flex; flex-direction: column; gap: 10px; position: relative; z-index: 1; }
  .b-col > h2 { font: 600 13px var(--sans); color: var(--text-2); margin: 0 0 2px; padding-bottom: 6px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 8px; }
  .b-col > h2 span { font-weight: 400; color: var(--text-3); white-space: nowrap; }
  .b-node { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 9px 11px 10px; }
  .b-node.dropped { opacity: 0.55; }
  .b-node.dropped .b-title { text-decoration: line-through; }
  .b-node.waiting { border-color: var(--accent); }
  .b-head { display: flex; gap: 6px; align-items: center; font: 11.5px var(--sans); color: var(--text-3); margin-bottom: 4px; }
  .b-kind { border: 1px solid var(--line); border-radius: 999px; padding: 0 7px; line-height: 17px; color: var(--text-2); }
  .b-node.waiting .b-st, .b-new { color: var(--accent); font-weight: 600; }
  .b-node.done .b-st { color: var(--ok); }
  .b-new { margin-left: auto; }
  .b-title { font: 600 14px/1.45 var(--sans); color: var(--text); overflow-wrap: anywhere; }
  .b-body { font: 13px/1.6 var(--sans); color: var(--text-2); margin-top: 5px; overflow-wrap: anywhere; }
  .b-body p { margin: 0 0 5px; }
  .b-body ul { margin: 0 0 5px; padding-left: 18px; }
  .b-body code { font: 12px var(--mono); background: var(--surface-2); border-radius: 3px; padding: 0 3px; }
  .b-body > :last-child { margin-bottom: 0; }
  .b-from { font: 11.5px var(--sans); color: var(--text-3); margin-top: 6px; }
  svg.b-lines { position: absolute; left: 0; top: 0; width: 1px; height: 1px; pointer-events: none; z-index: 0; overflow: visible; }
  svg.b-lines path { fill: none; stroke: var(--text-3); stroke-width: 1.3; opacity: 0.55; }
</style>
<div id="board"></div>
<script>
(function () {
  var GLYPH = { open: "○", doing: "◐", done: "✓", dropped: "×", waiting: "!" };
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function inline(s) { return esc(s).replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>"); }
  // A few lines of Markdown: paragraphs and "- " lists.
  function body(md) {
    var out = [], list = [], lines = String(md || "").split("\n");
    function flush() { if (list.length) { out.push("<ul>" + list.join("") + "</ul>"); list = []; } }
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim(); if (!l) { flush(); continue; }
      var m = /^[-*·]\s+(.*)$/.exec(l);
      if (m) list.push("<li>" + inline(m[1]) + "</li>"); else { flush(); out.push("<p>" + inline(l) + "</p>"); }
    }
    flush(); return out.join("");
  }
  var last = null;
  function lines() {
    var root = document.getElementById("board"), svg = root.querySelector("svg.b-lines"); if (!svg || !last) return;
    var base = root.querySelector(".b-cols").getBoundingClientRect(), d = [];
    function box(id) { var el = root.querySelector('[data-node="' + String(id).replace(/"/g, "") + '"]'); return el ? el.getBoundingClientRect() : null; }
    last.nodes.forEach(function (n) {
      (n.after || []).forEach(function (a) {
        var p = box(a), q = box(n.id); if (!p || !q) return;
        if (Math.abs(p.left - q.left) < 4) { // the same column: down (or up) its left side
          var x = p.left - base.left - 9, y1 = p.top + p.height / 2 - base.top, y2 = q.top + q.height / 2 - base.top;
          d.push("M" + (x + 9) + "," + y1 + " C" + (x - 6) + "," + y1 + " " + (x - 6) + "," + y2 + " " + (x + 9) + "," + y2);
        } else {
          var right = p.left < q.left, x1 = (right ? p.right : p.left) - base.left, x2 = (right ? q.left : q.right) - base.left;
          var ya = p.top + Math.min(p.height / 2, 22) - base.top, yb = q.top + Math.min(q.height / 2, 22) - base.top, mid = (x1 + x2) / 2;
          d.push("M" + x1 + "," + ya + " C" + mid + "," + ya + " " + mid + "," + yb + " " + x2 + "," + yb);
        }
      });
    });
    svg.innerHTML = d.map(function (p) { return '<path d="' + p + '"/>'; }).join("");
  }
  window.renderBoard = function (board) {
    last = board;
    var root = document.getElementById("board");
    if (!board.nodes.length) { root.innerHTML = '<div class="b-empty">白板上还没有内容。<br>AI 把任务内容、计划、建议和定下来的事写上来之后，会显示在这里。</div>'; return; }
    var groups = [], by = {};
    board.nodes.forEach(function (n) { var g = n.group || ""; if (!by[g]) { by[g] = []; groups.push(g); } by[g].push(n); });
    root.innerHTML = '<div class="b-cols"><svg class="b-lines"></svg>' + groups.map(function (g) {
      var open = by[g].filter(function (n) { return n.status !== "done" && n.status !== "dropped"; }).length;
      return '<section class="b-col"><h2>' + esc(g || "其他") + "<span>" + (open ? open + " 件没完" : "都完了") + "</span></h2>" + by[g].map(function (n) {
        return '<article class="b-node ' + esc(n.status) + '" data-node="' + esc(n.id) + '"><div class="b-head"><span class="b-kind">' + esc(board.kinds[n.kind] || n.kind) + '</span><span class="b-st">' + (GLYPH[n.status] || "") + " " + esc(board.statuses[n.status] || n.status) + "</span>" +
          (n.rev > board.seenRev ? '<span class="b-new">有变化</span>' : "") + '</div><div class="b-title">' + esc(n.title) + "</div>" +
          (n.body ? '<div class="b-body">' + body(n.body) + "</div>" : "") + (n.from ? '<div class="b-from">来自 ' + esc(n.from) + "</div>" : "") + "</article>";
      }).join("") + "</section>";
    }).join("") + "</div>";
    lines();
  };
  addEventListener("resize", lines);
})();
</script>
`;
