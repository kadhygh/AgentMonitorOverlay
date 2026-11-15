// 白板的页面放在它自己的 frame 里 (2026-11-16, plans/whiteboard.md; host/src/features/whiteboard/template.ts says what a page gets):
// the page may be the session AI's own HTML (whiteboard_view), so the frame is sandboxed — scripts only, an origin of its
// own, and a policy that loads nothing from anywhere: it cannot reach the workbench's page, the Host or the network.
// This side wraps the page with Studio's theme as CSS variables and a small script (whiteboardShell, below) that hands the
// board to the page's renderBoard, draws the person's notes as pins over it, and says what the person picked — a node
// (an element with data-node) or a place (right click) — back to the workbench.

/** Studio's theme under the names a board page uses. */
const THEME_VARS: Record<string, string> = {
  "--bg": "--bg",
  "--surface": "--panel",
  "--surface-2": "--panel-raised",
  "--text": "--text",
  "--text-2": "--text-dim",
  "--text-3": "--text-faint",
  "--line": "--border",
  "--accent": "--attention",
  "--ok": "--running",
  "--warn": "--error",
  "--sans": "--font-ui",
  "--serif": "--font-display",
  "--mono": "--font-code",
};

export function whiteboardTheme(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = { "--radius": "6px" };
  for (const [name, from] of Object.entries(THEME_VARS)) vars[name] = style.getPropertyValue(from).trim();
  return vars;
}

/** What the frame's script says to the workbench. */
export type WhiteboardFrameMessage =
  | { type: "board.ready" }
  /** A node was clicked (null: the empty page, or Esc). */
  | { type: "board.pick"; nodeId: string | null }
  /** A place was right-clicked: in a node (x, y from its corner) or on the page. `quote`: the words there. */
  | { type: "board.place"; nodeId?: string; x: number; y: number; quote?: string }
  /** A note's pin was clicked. */
  | { type: "board.note"; id: string }
  /** The page's own script failed. */
  | { type: "board.error"; message: string };

interface ShellNote {
  id: string;
  nodeId?: string;
  x?: number;
  y?: number;
  state: string;
  text: string;
}

/**
 * Runs inside the frame (written into the page as text, so it uses nothing from outside itself and plain syntax only).
 * From the workbench it takes board.data {board}, board.theme {vars} and board.mark {nodeId, noteId, place} — what is
 * selected there: outlined here, a note's pin brought into view.
 */
function whiteboardShell(): void {
  const say = (m: unknown) => parent.postMessage(m, "*");
  const pins = document.getElementById("amo-pins")!;
  const outline = document.getElementById("amo-sel")!;
  let board: { notes: ShellNote[] } | null = null;
  let mark: { nodeId?: string | null; noteId?: string | null; place?: { nodeId?: string; x: number; y: number } | null } = {};

  function nodeEl(id: string | null | undefined): HTMLElement | null {
    if (!id) return null;
    const all = document.querySelectorAll<HTMLElement>("[data-node]");
    for (let i = 0; i < all.length; i++) if (all[i]!.getAttribute("data-node") === id) return all[i]!;
    return null;
  }
  function box(el: Element): { left: number; top: number; width: number; height: number } {
    const r = el.getBoundingClientRect();
    return { left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height };
  }
  /** Where a note (or the place being written at) is on the page; null when its node is not drawn. */
  function spot(n: { nodeId?: string; x?: number; y?: number }, nth: number): { left: number; top: number } | null {
    if (!n.nodeId) return n.x === undefined || n.y === undefined ? null : { left: n.x, top: n.y };
    const el = nodeEl(n.nodeId);
    if (!el) return null;
    const b = box(el);
    // On the node itself: along its top edge, from the right.
    return n.x === undefined || n.y === undefined ? { left: b.left + b.width - 12 - nth * 22, top: b.top } : { left: b.left + n.x, top: b.top + n.y };
  }
  function layout(): void {
    const sel = nodeEl(mark.nodeId);
    if (sel) {
      const b = box(sel);
      outline.style.cssText = "display:block;left:" + (b.left - 3) + "px;top:" + (b.top - 3) + "px;width:" + (b.width + 2) + "px;height:" + (b.height + 2) + "px";
    } else outline.style.display = "none";
    const html: string[] = [];
    const onNode: Record<string, number> = {};
    const notes = board ? board.notes : [];
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i]!;
      if (n.state === "closed") continue;
      const plain = !!n.nodeId && n.x === undefined;
      const nth = plain ? (onNode[n.nodeId!] = (onNode[n.nodeId!] || 0) + 1) - 1 : 0;
      const at = spot(n, nth);
      if (!at) continue;
      const tip = n.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      html.push('<button type="button" class="amo-pin ' + n.state + (mark.noteId === n.id ? " on" : "") + '" data-note="' + n.id + '" title="' + tip + '" style="left:' + at.left + "px;top:" + at.top + 'px">' + n.id.replace(/^c/, "") + "</button>");
    }
    const here = mark.place ? spot(mark.place, 0) : null;
    if (here) html.push('<span class="amo-pin here" style="left:' + here.left + "px;top:" + here.top + 'px">…</span>');
    pins.innerHTML = html.join("");
  }
  function draw(): void {
    const w = window as unknown as { BOARD: unknown; renderBoard?: (b: unknown) => void };
    if (board && typeof w.renderBoard === "function") {
      try {
        w.renderBoard(board);
      } catch (err) {
        say({ type: "board.error", message: String((err && (err as Error).message) || err) });
      }
    }
    layout();
    // Once more when the page has laid itself out (fonts, pictures).
    requestAnimationFrame(layout);
  }

  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data) return;
    const m = e.data as { type?: string; board?: { notes: ShellNote[] }; vars?: Record<string, string>; nodeId?: string | null; noteId?: string | null; place?: { nodeId?: string; x: number; y: number } | null };
    if (m.type === "board.data" && m.board) {
      board = m.board;
      (window as unknown as { BOARD: unknown }).BOARD = m.board;
      draw();
    } else if (m.type === "board.theme" && m.vars) {
      for (const k in m.vars) document.documentElement.style.setProperty(k, m.vars[k]!);
      layout();
    } else if (m.type === "board.mark") {
      const was = mark.noteId;
      mark = { nodeId: m.nodeId, noteId: m.noteId, place: m.place };
      layout();
      const pin = m.noteId && m.noteId !== was ? pins.querySelector('[data-note="' + m.noteId + '"]') : null;
      if (pin) pin.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    }
  });
  document.addEventListener("click", (e) => {
    const t = e.target as Element;
    // Nothing in a board goes anywhere: a link would only load a page the frame may not load.
    if (t.closest("a")) e.preventDefault();
    const pin = t.closest(".amo-pin[data-note]");
    if (pin) return say({ type: "board.note", id: pin.getAttribute("data-note") });
    const node = t.closest("[data-node]");
    say({ type: "board.pick", nodeId: node ? node.getAttribute("data-node") : null });
  });
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const t = e.target as HTMLElement;
    const node = t.closest ? t.closest("[data-node]") : null;
    // The words under the pointer, when it is on a small piece of text and not on a whole node or the page.
    const words = t !== node && t !== document.body && t !== document.documentElement ? (t.innerText || "").replace(/\s+/g, " ").trim() : "";
    const quote = words && words.length <= 200 ? words.slice(0, 80) : "";
    const x = e.pageX;
    const y = e.pageY;
    if (node) {
      const b = box(node);
      say({ type: "board.place", nodeId: node.getAttribute("data-node"), x: Math.round(x - b.left), y: Math.round(y - b.top), quote: quote });
    } else say({ type: "board.place", x: Math.round(x), y: Math.round(y), quote: quote });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") say({ type: "board.pick", nodeId: null });
  });
  addEventListener("error", (e) => say({ type: "board.error", message: String(e.message || "页面里的脚本出错了") }));
  addEventListener("resize", layout);
  if (typeof ResizeObserver === "function") new ResizeObserver(layout).observe(document.body);
  say({ type: "board.ready" });
}

const SHELL_CSS = `
html { background: var(--bg); }
body { margin: 0; padding: 16px 18px 48px; color: var(--text); font: 13px/1.6 var(--sans); }
[data-node] { cursor: pointer; }
#amo-pins { position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483000; }
.amo-pin { position: absolute; transform: translate(-50%, -50%); box-sizing: border-box; min-width: 20px; height: 20px; padding: 0 5px; border: 1.5px solid var(--accent); border-radius: 10px 10px 10px 2px; background: var(--surface); color: var(--text); font: 600 11px/17px var(--sans); text-align: center; cursor: pointer; }
.amo-pin.draft { background: var(--accent); color: var(--bg); }
.amo-pin.answered { border-color: var(--ok); }
.amo-pin.on { outline: 2px solid var(--text); outline-offset: 1px; }
.amo-pin.here { border-style: dashed; cursor: default; }
#amo-sel { position: absolute; display: none; box-sizing: content-box; pointer-events: none; border: 2px solid var(--accent); border-radius: calc(var(--radius) + 2px); z-index: 2147482999; }
`;

/** The whole document of the frame for a board page (`html`: the inside of its body). */
export function whiteboardFrameDoc(html: string, theme: Record<string, string>): string {
  const vars = Object.entries(theme)
    .map(([k, v]) => `${k}: ${v};`)
    .join(" ");
  // The page comes first so its script has defined renderBoard when the shell says it is ready; a </script> inside
  // the shell's own text cannot happen (it has none), and the page's HTML is the page's own business.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: blob:; font-src data:"><style>:root { ${vars} }${SHELL_CSS}</style></head><body>${html}<div id="amo-sel"></div><div id="amo-pins"></div><script>(${whiteboardShell.toString()})();</script></body></html>`;
}
