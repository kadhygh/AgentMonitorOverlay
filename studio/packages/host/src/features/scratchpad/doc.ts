import { SCRATCHPAD_DEFAULT_PAGES, SCRATCHPAD_MAX_PAGES, type Scratchpad, type ScratchpadPage } from "@amo-studio/protocol";

// The scratchpad document as the Host keeps it (kv, no table): pure functions, so reading old data is unit-tested.

/** Every page ever written, including the ones beyond the count (lowering the count only hides them). */
export interface StoredScratchpad {
  pages: ScratchpadPage[];
  pageCount: number;
  activePage: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const emptyPage = (): ScratchpadPage => ({ text: "", attachments: [] });
const hasContent = (p: ScratchpadPage | undefined) => !!p && (p.text.length > 0 || p.attachments.length > 0);

function page(raw: unknown): ScratchpadPage {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    text: typeof o.text === "string" ? o.text : "",
    attachments: Array.isArray(o.attachments) ? o.attachments.filter((a): a is string => typeof a === "string") : [],
  };
}

/**
 * The stored document from its kv value. Without one, stage 2's single draft text (`legacyText`, kv "scratchpad")
 * becomes page 1, so nothing typed before stage 11 is lost. Damaged values fall back the same way.
 */
export function readScratchpad(raw: string | undefined, legacyText: string | undefined): StoredScratchpad {
  if (raw) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      if (o && Array.isArray(o.pages)) {
        const pages = o.pages.slice(0, SCRATCHPAD_MAX_PAGES).map(page);
        const pageCount = clamp(Math.trunc(Number(o.pageCount)) || SCRATCHPAD_DEFAULT_PAGES, 1, SCRATCHPAD_MAX_PAGES);
        while (pages.length < pageCount) pages.push(emptyPage());
        return { pages, pageCount, activePage: clamp(Math.trunc(Number(o.activePage)) || 0, 0, pageCount - 1) };
      }
    } catch {
      // fall through to the old text
    }
  }
  const pages = Array.from({ length: SCRATCHPAD_DEFAULT_PAGES }, emptyPage);
  pages[0]!.text = legacyText ?? "";
  return { pages, pageCount: SCRATCHPAD_DEFAULT_PAGES, activePage: 0 };
}

/** What the API shows: the pages within the count, and which hidden pages still hold something. */
export function visibleScratchpad(doc: StoredScratchpad, updatedAt: string | null): Scratchpad {
  const pages = doc.pages.slice(0, doc.pageCount).map((p) => ({ text: p.text, attachments: [...p.attachments] }));
  const keptPages = doc.pages.flatMap((p, i) => (i >= doc.pageCount && hasContent(p) ? [i + 1] : []));
  return { pages, activePage: clamp(doc.activePage, 0, doc.pageCount - 1), keptPages, updatedAt };
}

/** Sets the page count; pages past it are kept (trailing empty ones dropped) and the active page stays within it. */
export function withPageCount(doc: StoredScratchpad, count: number): StoredScratchpad {
  const pages = doc.pages.map((p) => ({ ...p }));
  while (pages.length < count) pages.push(emptyPage());
  while (pages.length > count && !hasContent(pages[pages.length - 1])) pages.pop();
  return { pages, pageCount: count, activePage: Math.min(doc.activePage, count - 1) };
}

/** Replaces the text and/or images of a page (0-based index, any page up to the maximum). */
export function withPage(doc: StoredScratchpad, index: number, patch: Partial<ScratchpadPage>): StoredScratchpad {
  const pages = doc.pages.map((p) => ({ ...p }));
  while (pages.length <= index) pages.push(emptyPage());
  pages[index] = { ...pages[index]!, ...patch };
  return { ...doc, pages };
}
