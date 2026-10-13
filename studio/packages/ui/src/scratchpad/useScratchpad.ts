import { useCallback, useEffect, useRef, useState } from "react";
import { SCRATCHPAD_MAX_IMAGES, type Scratchpad } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent, onHostReconnect } from "../host/events.js";
import { uploadAttachment } from "../lib/attachments.js";

const SAVE_DELAY_MS = 500;

export type SaveState = "idle" | "dirty" | "saving" | "saved" | "uploading" | "error";

export interface ScratchpadApi {
  doc: Scratchpad | null;
  state: SaveState;
  error: string | null;
  /** A page's text as shown here: what is typed but not yet saved wins over the Host's. */
  textOf(page: number): string;
  setText(page: number, text: string): void;
  setActive(page: number): void;
  setPageCount(count: number): void;
  addImages(page: number, files: readonly Blob[]): Promise<void>;
  removeImage(page: number, id: string): void;
}

const message = (err: unknown) => (err instanceof HostApiError ? err.message : String(err));

/**
 * The shared scratchpad document, live: the window and the task page's entry both use it. Typing saves shortly after
 * it stops (per page) and is flushed when the view goes away; edits from other windows replace a page unless this
 * one has unsaved typing on it.
 */
export function useScratchpad(link: HostLink): ScratchpadApi {
  const [doc, setDocState] = useState<Scratchpad | null>(null);
  // Responses can arrive out of order (a page saved just before a page switch): an older document never replaces a
  // newer one. Events come in order and end on the latest anyway.
  const setDoc = useCallback((next: Scratchpad) => setDocState((cur) => (!cur?.updatedAt || !next.updatedAt || next.updatedAt >= cur.updatedAt ? next : cur)), []);
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [, rerender] = useState(0);
  const drafts = useRef(new Map<number, string>());
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const latest = useRef<Scratchpad | null>(null);
  latest.current = doc;

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      call(link, "GET /api/scratchpad")
        .then((s) => !cancelled && setDocState(s))
        .catch(() => undefined);
    const offEvent = onHostEvent((e) => {
      if (e.type === "scratchpad.updated") setDoc(e.scratchpad);
    });
    const offReconnect = onHostReconnect(() => void load());
    void load();
    return () => {
      cancelled = true;
      offEvent();
      offReconnect();
    };
  }, [link, setDoc]);

  const save = useCallback(
    (page: number) => {
      const t = timers.current.get(page);
      if (t) clearTimeout(t);
      timers.current.delete(page);
      const text = drafts.current.get(page);
      if (text === undefined) return Promise.resolve();
      setState("saving");
      return call(link, "PUT /api/scratchpad/pages/:page", { page: String(page + 1) }, { text })
        .then((s) => {
          // Typing that came in meanwhile stays a draft and saves on its own timer.
          if (drafts.current.get(page) === text) drafts.current.delete(page);
          setDoc(s);
          setError(null);
          setState(drafts.current.size ? "dirty" : "saved");
        })
        .catch((err: unknown) => {
          setError(message(err));
          setState("error");
        });
    },
    [link, setDoc],
  );

  // Leaving (or closing the window) right after typing must not drop the last edit.
  useEffect(() => {
    const flush = () => {
      for (const page of [...drafts.current.keys()]) void save(page);
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [save]);

  const textOf = (page: number) => drafts.current.get(page) ?? doc?.pages[page]?.text ?? "";

  function setText(page: number, text: string) {
    drafts.current.set(page, text);
    rerender((n) => n + 1);
    setState("dirty");
    const t = timers.current.get(page);
    if (t) clearTimeout(t);
    timers.current.set(page, setTimeout(() => void save(page), SAVE_DELAY_MS));
  }

  function patch(body: { activePage?: number; pageCount?: number }) {
    call(link, "PATCH /api/scratchpad", {}, body)
      .then((s) => setDoc(s))
      .catch((err: unknown) => {
        setError(message(err));
        setState("error");
      });
  }

  function setActive(page: number) {
    const current = latest.current;
    if (!current || page === current.activePage || page < 0 || page >= current.pages.length) return;
    // Switch at once (the Host confirms); the page left behind saves now.
    void save(current.activePage);
    setDoc({ ...current, activePage: page });
    patch({ activePage: page });
  }

  function setPageCount(count: number) {
    for (const page of [...drafts.current.keys()]) void save(page);
    patch({ pageCount: count });
  }

  function putImages(page: number, attachments: string[]) {
    return call(link, "PUT /api/scratchpad/pages/:page", { page: String(page + 1) }, { attachments }).then((s) => setDoc(s));
  }

  async function addImages(page: number, files: readonly Blob[]) {
    if (!files.length) return;
    if ((latest.current?.pages[page]?.attachments.length ?? 0) + files.length > SCRATCHPAD_MAX_IMAGES) {
      setError(`一页最多放 ${SCRATCHPAD_MAX_IMAGES} 张图片`);
      setState("error");
      return;
    }
    setState("uploading");
    setError(null);
    try {
      const ids: string[] = [];
      for (const file of files) ids.push((await uploadAttachment(link, file)).id);
      // The page's images as they are now: another window may have added some while these uploaded.
      const fresh = await call(link, "GET /api/scratchpad");
      const have = fresh.pages[page]?.attachments ?? [];
      await putImages(page, [...have, ...ids]);
      setState("saved");
    } catch (err) {
      setError(message(err));
      setState("error");
    }
  }

  function removeImage(page: number, id: string) {
    const have = latest.current?.pages[page]?.attachments ?? [];
    putImages(
      page,
      have.filter((x) => x !== id),
    ).catch((err: unknown) => {
      setError(message(err));
      setState("error");
    });
  }

  return { doc, state, error, textOf, setText, setActive, setPageCount, addImages, removeImage };
}

/** The footer's word for the save state. */
export const SAVE_LABELS: Record<SaveState, string> = { idle: "", dirty: "", saving: "保存中…", saved: "已保存", uploading: "图片上传中…", error: "保存失败" };
