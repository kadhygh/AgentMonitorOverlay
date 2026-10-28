import type { GitCommentPoint } from "@amo-studio/protocol";
import { passageKit, type PassageAnchor } from "./passageKit.js";

// 渲染批注 (2026-10-28): what the viewer needs around a rendered file's passages — where a passage sits in the source,
// which Markdown an HTML file was made from, and the HTML file as its frame shows it (its scripts running, ours added).

/**
 * The source line a passage starts on, best guess (1 when it cannot be told): the words as written, then the words
 * with Markdown marks or HTML tags between them, then the first few characters.
 */
export function sourceLine(source: string, quote: string, html: boolean): number {
  const src = source.replace(/\r\n?/g, "\n");
  const lineAt = (i: number) => src.slice(0, i).split("\n").length;
  const words = quote.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const exact = src.indexOf(words.join(" "));
  if (exact >= 0) return lineAt(exact);
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const gap = html ? "(?:\\s|<[^>]*>|&[#\\w]+;)*" : "[\\s*_`>|#~\\[\\]()-]*";
  // Characters run together across marks too (**粗**体 renders as one word).
  const pattern = words
    .slice(0, 12)
    .map((w) => [...w].map(esc).join(html ? "(?:<[^>]*>)*" : "[*_`~]*"))
    .join(gap);
  const m = new RegExp(pattern).exec(src);
  if (m) return lineAt(m.index);
  const head = words[0]!.slice(0, 8);
  const loose = src.indexOf(head);
  return loose >= 0 ? lineAt(loose) : 1;
}

/** `a/b` from `dir` and `rel`, with `.` and `..` worked out; null when it climbs out of the project. */
function joinPath(dir: string, rel: string): string | null {
  const out: string[] = dir ? dir.split("/") : [];
  for (const part of rel.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

/**
 * Where an HTML file's Markdown source may be, most likely first, as paths relative to the project (absolute ones as
 * written): a `<meta name="amo-source">`, the same name with `.md` beside it, then the `.md` files its footer names
 * (from the HTML's folder, then from the project's).
 */
export function sourceCandidates(html: string, relPath: string): string[] {
  const rel = relPath.replace(/\\/g, "/");
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const out: string[] = [];
  const add = (p: string | null) => p && !out.includes(p) && out.push(p);
  const named = (p: string) => {
    const clean = p.trim().replace(/^file:\/\/\/?/i, "");
    if (/^[a-z]:[\\/]/i.test(clean) || clean.startsWith("/")) return add(clean.replace(/\\/g, "/"));
    add(joinPath(dir, clean));
    add(joinPath("", clean));
  };
  const meta = /<meta\s[^>]*name=["']amo-source["'][^>]*>/i.exec(html)?.[0];
  const content = meta && /content=["']([^"']+)["']/i.exec(meta)?.[1];
  if (content) named(content);
  if (/\.html?$/i.test(rel)) add(rel.replace(/\.html?$/i, ".md"));
  const footer = /<footer[\s>][\s\S]*?<\/footer>/i.exec(html)?.[0] ?? html.slice(-3000);
  const text = footer.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");
  for (const m of text.matchAll(/(?:[a-z]:[\\/])?[\w\-.\\/㐀-鿿]+\.md\b/gi)) named(m[0]);
  return out;
}

/** Where a link of a rendered file goes: the web, a heading of the same file, or another file (opened in the viewer). */
export type LinkTarget = { kind: "web"; url: string } | { kind: "anchor"; id: string } | { kind: "file"; path: string; line?: number } | null;

/**
 * A link of the file at `fromPath` (absolute), as written: `https://…`, `#heading`, or a file — relative to the file's
 * folder, absolute, or `file:///…` — maybe with `#L12` or `:12`. Null for what the viewer does not follow (mailto:,
 * javascript:…).
 */
export function resolveLink(fromPath: string, href: string): LinkTarget {
  const h = href.trim();
  if (!h) return null;
  if (/^https?:\/\//i.test(h)) return { kind: "web", url: h };
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  if (h.startsWith("#")) return h.length > 1 ? { kind: "anchor", id: decode(h.slice(1)) } : null;
  const drive = /^\/?[a-z]:[\\/]/i;
  if (/^[a-z][a-z0-9+.-]+:/i.test(h) && !/^file:/i.test(h) && !drive.test(h)) return null;
  let p = h.replace(/^file:\/\//i, "");
  const hash = p.indexOf("#");
  const frag = hash >= 0 ? p.slice(hash + 1) : "";
  p = decode((hash >= 0 ? p.slice(0, hash) : p).replace(/\?.*$/, "")).replace(/\\/g, "/");
  if (!p) return null;
  let line = Number(/^L?(\d+)/i.exec(frag)?.[1] ?? 0);
  const colon = /^(.*\.[\w-]+):(\d+)(?::\d+)?$/.exec(p);
  if (colon) (p = colon[1]!), (line = Number(colon[2]));
  if (/^\/[a-z]:\//i.test(p)) p = p.slice(1);
  const from = fromPath.replace(/\\/g, "/");
  const abs = /^[a-z]:\//i.test(p) || p.startsWith("/") ? p : `${from.slice(0, from.lastIndexOf("/"))}/${p}`;
  const out: string[] = [];
  for (const part of abs.split("/")) {
    if (part === ".") continue;
    if (part === "..") {
      if (out.length > 1) out.pop();
    } else if (part || !out.length) out.push(part);
  }
  return { kind: "file", path: out.join("/"), ...(line > 0 ? { line } : {}) };
}

/** A heading's anchor as Markdown renderers write it: lower case, punctuation dropped, spaces as dashes. */
export const headingSlug = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");

/** A message between the viewer and an HTML file's frame. */
export type FrameMessage =
  | { type: "ready" }
  | { type: "placed"; found: string[] }
  | { type: "select"; anchor: PassageAnchor | null; rect?: { left: number; top: number; right: number; bottom: number } }
  | { type: "hit"; id: string }
  | { type: "scroll" }
  | { type: "press" }
  | { type: "link"; href: string }
  | { type: "copy"; text: string }
  /** A right click on the page (位置批注): the place, its element's source line, the words nearest it, and the selection if any. */
  | { type: "point"; x: number; y: number; line: number; point: GitCommentPoint; near: PassageAnchor; selection: PassageAnchor | null };

/** A place to pin on the page: `n` is the label on its pin, `draft` the one being written. */
export type PointMark = PassageAnchor & { id: string; n: string; point: GitCommentPoint; draft?: boolean };

export type ToFrame = { type: "marks"; marks: Array<PassageAnchor & { id: string }>; points: PointMark[]; hot: string | null } | { type: "go"; id: string } | { type: "clear" };

/** Elements whose content is not markup: what is inside is left alone. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "noscript", "iframe", "noembed", "noframes", "plaintext"]);

/**
 * 位置批注 (2026-10-28): each start tag of the HTML source gets `data-amo-line="N"`, the line it is on, so a place
 * right-clicked on the page can name the line of its element. Only the attribute is added; comments, scripts and
 * styles are copied as they are.
 */
export function lineTags(html: string): string {
  const lower = html.toLowerCase();
  const out: string[] = [];
  let copied = 0;
  let line = 1;
  let counted = 0;
  const lineAt = (at: number) => {
    for (; counted < at; counted++) if (html.charCodeAt(counted) === 10) line++;
    return line;
  };
  let i = html.indexOf("<");
  while (i >= 0) {
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? -1 : html.indexOf("<", end + 3);
      continue;
    }
    const name = /^<([a-zA-Z][\w:-]*)/.exec(html.slice(i, i + 80))?.[1];
    if (!name) {
      // An end tag, a doctype, or a lone `<` in the text.
      const closes = /^<[/!?]/.test(html.slice(i, i + 2));
      const end = closes ? html.indexOf(">", i + 1) : i;
      i = end < 0 ? -1 : html.indexOf("<", end + 1);
      continue;
    }
    const at = i + 1 + name.length;
    out.push(html.slice(copied, at), ` data-amo-line="${lineAt(i)}"`);
    copied = at;
    let k = at;
    for (let quote = ""; k < html.length; k++) {
      const c = html[k];
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
    }
    const tag = name.toLowerCase();
    if (RAW_TEXT.has(tag) && html[k - 1] !== "/") {
      const end = lower.indexOf(`</${tag}`, k);
      i = end;
    } else i = html.indexOf("<", k + 1);
  }
  out.push(html.slice(copied));
  return out.join("");
}

/**
 * Runs in the HTML file's frame, before the page's own scripts. The frame is sandboxed without this window's origin,
 * so it talks by messages only: it reports selections, paints the passages it is given, goes to one, and stands in
 * for what a sandboxed page lacks — storage (kept in memory) and the clipboard (through the viewer). Links leave the
 * frame through the viewer. Self-contained, as passageKit.
 */
function frameMain(makeKit: typeof passageKit) {
  const kit = makeKit();
  const post = (m: unknown) => parent.postMessage({ amoPassage: m }, "*");
  const w = window as unknown as Record<string, unknown>;
  for (const name of ["localStorage", "sessionStorage"]) {
    try {
      void w[name];
    } catch {
      const data = new Map<string, string>();
      const store = {
        getItem: (k: string) => data.get(String(k)) ?? null,
        setItem: (k: string, v: string) => void data.set(String(k), String(v)),
        removeItem: (k: string) => void data.delete(String(k)),
        clear: () => data.clear(),
        key: (i: number) => [...data.keys()][i] ?? null,
        get length() {
          return data.size;
        },
      };
      try {
        Object.defineProperty(window, name, { configurable: true, value: store });
      } catch {
        // left as it is
      }
    }
  }
  const copy = (t: unknown) => post({ type: "copy", text: String(t) });
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (t: string) => (copy(t), Promise.resolve()), readText: () => Promise.reject(new Error("clipboard")) },
    });
  } catch {
    // left as it is
  }
  const exec = document.execCommand.bind(document);
  document.execCommand = (c: string, ...a: unknown[]) => {
    if (String(c).toLowerCase() !== "copy") return exec(c, ...(a as [boolean, string]));
    const el = document.activeElement as HTMLInputElement | null;
    const v = el && typeof el.value === "string" && el.selectionStart != null ? el.value.slice(el.selectionStart, el.selectionEnd ?? undefined) : "";
    copy(v || String(getSelection() ?? ""));
    return true;
  };

  let marks: Array<{ id: string; quote: string; prefix: string; suffix: string }> = [];
  let hot: string | null = null;
  const ranges = new Map<string, Range>();
  const style = document.createElement("style");
  style.textContent = "::highlight(amo-passage){background:rgba(217,119,87,.30)}::highlight(amo-passage-hot){background:rgba(217,119,87,.62)}";
  const reg = () => (window as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const H = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  function paint() {
    ranges.clear();
    const body = document.body;
    if (!body) return;
    if (!style.isConnected) (document.head ?? document.documentElement).appendChild(style);
    const flat = kit.flatten(body);
    for (const m of marks) {
      const r = kit.rangeOf(body, m, flat);
      if (r) ranges.set(m.id, r);
    }
    const highlights = reg();
    if (highlights && H) {
      highlights.set("amo-passage", new H(...ranges.values()));
      const h = hot ? ranges.get(hot) : undefined;
      if (h) highlights.set("amo-passage-hot", new H(h));
      else highlights.delete("amo-passage-hot");
    }
    placePins(flat);
    post({ type: "placed", found: [...ranges.keys(), ...located.filter((l) => !l.draft).map((l) => l.id)] });
  }

  // ---- 位置批注 (2026-10-28): a right click anywhere offers a comment on that place; pins show where they are ----
  let points: PointMark[] = [];
  const tagOf = (el: Element) => el.tagName.toLowerCase();
  const short = (s: string, n = 24) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const ownText = (el: Element) => kit.norm(el.getAttribute("aria-label") || (el as HTMLImageElement).alt || el.textContent || el.getAttribute("title") || "").slice(0, 40);
  /** From <body> down, tag:nth-of-type; "body" for the body itself. */
  function pathOf(el: Element): string {
    const out: string[] = [];
    for (let e: Element | null = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      let n = 1;
      for (let s = e.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === e.tagName) n++;
      out.unshift(`${tagOf(e)}:${n}`);
    }
    return out.join(">") || "body";
  }
  function byPath(path: string): Element | null {
    let el: Element | null = document.body;
    if (path === "body") return el;
    for (const step of path.split(">")) {
      const [tag, nth] = step.split(":");
      let left = Number(nth);
      let hit: Element | null = null;
      for (const c of Array.from(el?.children ?? [])) if (tagOf(c) === tag && --left === 0) (hit = c);
      if (!hit) return null;
      el = hit;
    }
    return el;
  }
  const NAMES: Record<string, string> = { button: "按钮", a: "链接", p: "段落", pre: "代码块", code: "代码", summary: "折叠块的标题", details: "折叠块", figure: "图", figcaption: "图注", blockquote: "引用", table: "表格", nav: "导航", header: "页头", footer: "页脚", label: "标签", input: "输入框", select: "下拉框" };
  /** Where `el` is, in words: the headings it is under, the element, and where in it when it is big. */
  function describe(el: Element, fx: number, fy: number): string {
    const trail: Array<{ level: number; text: string }> = [];
    for (const h of Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
      if (h !== el && !h.contains(el) && h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) break;
      const level = Number(h.tagName[1]);
      while (trail.length && trail[trail.length - 1]!.level >= level) trail.pop();
      trail.push({ level, text: short(kit.norm(h.textContent ?? ""), 20) });
    }
    const quoted = (s: string) => (s ? `「${short(s)}」` : "");
    const tag = tagOf(el);
    const cell = el.closest("td, th") as HTMLTableCellElement | null;
    const svg = el.closest("svg");
    const li = el.closest("li");
    let what: string;
    if (el === document.body || el === document.documentElement) what = "页面空白处";
    else if (cell) {
      const table = cell.closest("table");
      const row = table ? Array.from(table.rows).indexOf(cell.parentElement as HTMLTableRowElement) + 1 : 0;
      what = `表格第 ${row} 行第 ${cell.cellIndex + 1} 列${quoted(kit.norm(cell.textContent ?? ""))}`;
    } else if (svg) what = `图（SVG）${quoted(kit.norm(el.textContent || svg.querySelector("title")?.textContent || svg.getAttribute("aria-label") || ""))}`;
    else if (tag === "img") what = `图片${quoted(ownText(el))}`;
    else if (tag === "canvas") what = "画布（canvas）";
    else if (/^h[1-6]$/.test(tag)) what = `标题${quoted(ownText(el))}`;
    else if (li?.parentElement) what = `列表第 ${Array.from(li.parentElement.children).indexOf(li) + 1} 项${quoted(kit.norm(li.textContent ?? ""))}`;
    else what = `${NAMES[tag] ?? `<${tag}>`}${quoted(ownText(el))}`;
    const box = el.getBoundingClientRect();
    if (box.width > 160 || box.height > 80) {
      const side = (fy < 1 / 3 ? "上" : fy > 2 / 3 ? "下" : "") + (fx < 1 / 3 ? "左" : fx > 2 / 3 ? "右" : "");
      what += side ? `（偏${side}）` : "（中间）";
    }
    return [...trail.slice(-2).map((t) => `「${t.text}」`), what].join(" › ");
  }
  /** The words nearest a place: under the pointer, else the first in its element, else the last before it. */
  function nearWords(x: number, y: number, el: Element) {
    const body = document.body;
    const none = { quote: "", prefix: "", suffix: "" };
    if (!body) return none;
    const flat = kit.flatten(body);
    const caret = (document as unknown as { caretRangeFromPoint?: (x: number, y: number) => Range | null }).caretRangeFromPoint?.(x, y);
    let at = -1;
    if (caret && caret.startContainer.nodeType === 3 && el.contains(caret.startContainer)) at = flat.at.findIndex((p) => p.node === caret.startContainer && p.offset >= caret.startOffset);
    if (at < 0) at = flat.at.findIndex((p) => el.contains(p.node));
    if (at < 0) for (let k = flat.at.length - 1; k >= 0 && at < 0; k--) if (flat.at[k]!.node.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) at = k;
    if (at < 0) return none;
    let start = Math.max(0, at - 10);
    let end = Math.min(flat.text.length, start + 30);
    while (start < end && flat.text[start] === " ") start++;
    while (end > start && flat.text[end - 1] === " ") end--;
    return { quote: flat.text.slice(start, end), prefix: flat.text.slice(Math.max(0, start - kit.CONTEXT), start).trimStart(), suffix: flat.text.slice(end, end + kit.CONTEXT).trimEnd() };
  }

  let host: HTMLElement | null = null;
  let pinRoot: ShadowRoot | null = null;
  let located: Array<{ id: string; draft: boolean; el: Element; box: () => DOMRect; fx: number; fy: number; pin: HTMLElement }> = [];
  function layer(): ShadowRoot {
    if (host?.isConnected && pinRoot) return pinRoot;
    host = document.createElement("amo-pins");
    host.setAttribute("style", "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647");
    pinRoot = host.attachShadow({ mode: "open" });
    const css = document.createElement("style");
    css.textContent =
      ".pin{position:absolute;box-sizing:border-box;min-width:20px;height:20px;margin:-10px 0 0 -10px;padding:0 4px;border:2px solid #fff;border-radius:10px;background:#d97757;color:#fff;font:600 11px/16px system-ui,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.35);pointer-events:auto;cursor:pointer}" +
      ".pin.hot{background:#a8492a;transform:scale(1.2)}.pin.draft{background:#fff;color:#d97757;border-color:#d97757}";
    pinRoot.appendChild(css);
    document.documentElement.appendChild(host);
    return pinRoot;
  }
  /** Where a place is now: its element by id, by path (the same text), else beside its words; null when gone. */
  function find(m: PointMark, flat: ReturnType<typeof kit.flatten>) {
    const p = m.point;
    const byId = p.id ? document.getElementById(p.id) : null;
    if (byId) return { el: byId as Element, box: () => byId.getBoundingClientRect(), fx: p.x, fy: p.y };
    const el = byPath(p.path);
    if (el && (!p.text || ownText(el).startsWith(p.text.slice(0, 12)))) return { el, box: () => el.getBoundingClientRect(), fx: p.x, fy: p.y };
    const r = m.quote && document.body ? kit.rangeOf(document.body, m, flat) : null;
    if (r) return { el: r.startContainer.parentElement ?? document.body, box: () => r.getBoundingClientRect(), fx: 0, fy: 0.5 };
    return null;
  }
  function placePins(flat: ReturnType<typeof kit.flatten>) {
    if (!points.length && !located.length) return;
    const root = layer();
    for (const l of located) l.pin.remove();
    located = [];
    for (const m of points) {
      const f = find(m, flat);
      if (!f) continue;
      const pin = document.createElement("span");
      pin.className = m.draft ? "pin draft" : "pin";
      pin.textContent = m.n;
      pin.title = m.point.where;
      pin.addEventListener("click", () => !m.draft && post({ type: "hit", id: m.id }));
      root.appendChild(pin);
      located.push({ id: m.id, draft: !!m.draft, ...f, pin });
    }
    layoutPins();
  }
  function layoutPins() {
    for (const l of located) {
      const b = l.box();
      // Folded away or not shown: no pin.
      l.pin.style.display = b.width || b.height ? "" : "none";
      l.pin.style.left = `${b.left + b.width * l.fx}px`;
      l.pin.style.top = `${b.top + b.height * l.fy}px`;
      l.pin.classList.toggle("hot", l.id === hot);
    }
  }
  let pinFrame = 0;
  const relayout = () => {
    if (located.length && !pinFrame)
      pinFrame = requestAnimationFrame(() => {
        pinFrame = 0;
        layoutPins();
      });
  };
  window.addEventListener("scroll", relayout, { capture: true, passive: true });
  window.addEventListener("resize", relayout);
  document.addEventListener("toggle", relayout, true);
  new ResizeObserver(relayout).observe(document.documentElement);
  // After the page's own handlers: a page with a right-click menu of its own keeps it.
  window.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented || !document.body) return;
    let el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el === host) return;
    e.preventDefault();
    if (el === document.documentElement) el = document.body;
    const box = el.getBoundingClientRect();
    const frac = (v: number, from: number, size: number) => (size ? Math.min(1, Math.max(0, (v - from) / size)) : 0.5);
    const fx = frac(e.clientX, box.left, box.width);
    const fy = frac(e.clientY, box.top, box.height);
    const line = Number(el.closest("[data-amo-line]")?.getAttribute("data-amo-line")) || 1;
    const sel = getSelection();
    const selection = sel && !sel.isCollapsed && sel.rangeCount ? kit.anchorOf(document.body, sel.getRangeAt(0)) : null;
    const point = { where: describe(el, fx, fy), path: pathOf(el), ...(el.id ? { id: el.id } : {}), text: ownText(el), x: fx, y: fy };
    post({ type: "point", x: e.clientX, y: e.clientY, line, point, near: nearWords(e.clientX, e.clientY, el), selection });
  });
  document.addEventListener("pointerdown", () => post({ type: "press" }), true);

  let timer: ReturnType<typeof setTimeout> | null = null;
  new MutationObserver(() => {
    if ((!marks.length && !points.length) || timer) return;
    timer = setTimeout(() => {
      timer = null;
      paint();
    }, 150);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const d = (e.data as { amoPassage?: { type: string; marks?: typeof marks; points?: PointMark[]; hot?: string | null; id?: string } } | null)?.amoPassage;
    if (!d) return;
    if (d.type === "marks") {
      marks = d.marks ?? [];
      points = d.points ?? [];
      hot = d.hot ?? null;
      paint();
    } else if (d.type === "go" && d.id) {
      hot = d.id;
      const place = located.find((l) => l.id === d.id);
      if (place) {
        for (let el: Element | null = place.el; el; el = el.parentElement) if (el.tagName === "DETAILS" && !(el as HTMLDetailsElement).open) (el as HTMLDetailsElement).open = true;
        place.el.scrollIntoView({ block: "center" });
        return paint();
      }
      const r0 = ranges.get(d.id);
      // A passage in a folded part: open it first.
      for (let el = r0?.startContainer.parentElement ?? null; el; el = el.parentElement) if (el.tagName === "DETAILS" && !(el as HTMLDetailsElement).open) (el as HTMLDetailsElement).open = true;
      paint();
      const r = ranges.get(d.id);
      if (!r) return;
      const box = r.getBoundingClientRect();
      window.scrollBy({ top: box.top - Math.max(40, (innerHeight - box.height) / 2) });
    } else if (d.type === "clear") getSelection()?.removeAllRanges();
  });

  const report = () => {
    const sel = getSelection();
    const body = document.body;
    if (!sel || sel.isCollapsed || !sel.rangeCount || !body) {
      post({ type: "select", anchor: null });
      return false;
    }
    const range = sel.getRangeAt(0);
    const anchor = kit.anchorOf(body, range);
    const boxes = [...range.getClientRects()].filter((b) => b.width > 0 && b.height > 0);
    const last = boxes[boxes.length - 1] ?? range.getBoundingClientRect();
    post({ type: "select", anchor, rect: { left: last.left, top: last.top, right: last.right, bottom: last.bottom } });
    return !!anchor;
  };
  document.addEventListener("mouseup", (e) =>
    setTimeout(() => {
      if (report()) return;
      for (const [id, r] of ranges)
        for (const b of r.getClientRects())
          if (e.clientX >= b.left && e.clientX <= b.right && e.clientY >= b.top && e.clientY <= b.bottom) return post({ type: "hit", id });
    }, 0),
  );
  document.addEventListener("keyup", (e) => e.shiftKey && report());
  window.addEventListener("scroll", () => post({ type: "scroll" }), { capture: true, passive: true });
  document.addEventListener(
    "click",
    (e) => {
      // As written: resolved here it would be against the viewer's own address.
      const href = ((e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null)?.getAttribute("href") ?? "";
      if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return;
      e.preventDefault();
      post({ type: "link", href });
    },
    true,
  );
  // In-page anchors: a srcdoc page reads `#x` against the viewer's address, so they would not move; done here, after
  // the page's own handlers (tabs and the like take theirs first).
  window.addEventListener("click", (e) => {
    const href = ((e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null)?.getAttribute("href") ?? "";
    if (!href.startsWith("#") || e.defaultPrevented) return;
    e.preventDefault();
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // as written
    }
    const to = id ? (document.getElementById(id) ?? document.getElementsByName(id)[0]) : null;
    for (let el = to?.parentElement ?? null; el; el = el.parentElement) if (el.tagName === "DETAILS" && !(el as HTMLDetailsElement).open) (el as HTMLDetailsElement).open = true;
    if (to) to.scrollIntoView({ block: "start" });
    else if (!id || id === "top") scrollTo(0, 0);
  });
  document.addEventListener("DOMContentLoaded", () => post({ type: "ready" }));
}

const FRAME_SCRIPT = `<script>(${frameMain.toString()})(${passageKit.toString()})</script>`;

/** The HTML file as its frame gets it: our script first in <head>, before the page's own; its tags marked with their lines. */
export function frameDoc(source: string): string {
  const html = lineTags(source);
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + FRAME_SCRIPT + html.slice(head.index + head[0].length);
  const top = /^\s*(<!doctype[^>]*>)?\s*(<html[^>]*>)?/i.exec(html)!;
  return html.slice(0, top[0].length) + FRAME_SCRIPT + html.slice(top[0].length);
}
