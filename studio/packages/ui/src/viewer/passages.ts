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

/** A message between the viewer and an HTML file's frame. */
export type FrameMessage =
  | { type: "ready" }
  | { type: "placed"; found: string[] }
  | { type: "select"; anchor: PassageAnchor | null; rect?: { left: number; top: number; right: number; bottom: number } }
  | { type: "hit"; id: string }
  | { type: "scroll" }
  | { type: "link"; href: string }
  | { type: "copy"; text: string };

export type ToFrame = { type: "marks"; marks: Array<PassageAnchor & { id: string }>; hot: string | null } | { type: "go"; id: string } | { type: "clear" };

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
    post({ type: "placed", found: [...ranges.keys()] });
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  new MutationObserver(() => {
    if (!marks.length || timer) return;
    timer = setTimeout(() => {
      timer = null;
      paint();
    }, 150);
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  window.addEventListener("message", (e) => {
    if (e.source !== parent) return;
    const d = (e.data as { amoPassage?: { type: string; marks?: typeof marks; hot?: string | null; id?: string } } | null)?.amoPassage;
    if (!d) return;
    if (d.type === "marks") {
      marks = d.marks ?? [];
      hot = d.hot ?? null;
      paint();
    } else if (d.type === "go" && d.id) {
      hot = d.id;
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
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.getAttribute("href") ?? "").startsWith("#")) return;
      e.preventDefault();
      post({ type: "link", href: a.href });
    },
    true,
  );
  document.addEventListener("DOMContentLoaded", () => post({ type: "ready" }));
}

const FRAME_SCRIPT = `<script>(${frameMain.toString()})(${passageKit.toString()})</script>`;

/** The HTML file as its frame gets it: our script first in <head>, before the page's own. */
export function frameDoc(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + FRAME_SCRIPT + html.slice(head.index + head[0].length);
  const top = /^\s*(<!doctype[^>]*>)?\s*(<html[^>]*>)?/i.exec(html)!;
  return html.slice(0, top[0].length) + FRAME_SCRIPT + html.slice(top[0].length);
}
