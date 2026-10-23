import { useEffect, useRef, useState, type JSX } from "react";
import { viewItemDetail, viewItemLabel, type StateSnapshot, type ViewItemKind, type ViewPack } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";
import { showToast } from "../lib/toast.js";
import { pinViewer, viewerPinned } from "../viewer/open.js";
import { useFitWidth } from "../lib/fitWidth.js";
import { itemToShow } from "./logic.js";
import { VIEW_KIND_VIEWS, type ItemViewProps } from "./kinds.js";

// The 查看包 window (2026-10-23): the viewer window showing a pack — its items in a list on the left, the one picked
// on the right, drawn by its kind (kinds.tsx). The pack is read from the Host and followed: when the agent adds to
// it, the window shows what was added. Reused for the next pack until 固定, as the viewer is.

export function PackViewer({ link, state, packId, focus, nonce }: { link: HostLink; state: StateSnapshot; packId: string; focus: string | null; nonce: string }) {
  const [pack, setPack] = useState<ViewPack | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const shown = useRef<ViewPack | null>(null);
  const head = useRef<HTMLElement>(null);
  useFitWidth(head);

  const take = (next: ViewPack) => {
    setSelected((cur) => itemToShow(shown.current?.id === next.id ? shown.current : null, next, cur));
    shown.current = next;
    setPack(next);
  };
  useEffect(() => {
    let live = true;
    setError(null);
    call(link, "GET /api/viewpacks/:id", { id: packId })
      .then((p) => {
        if (!live) return;
        take(p);
        // Opened at an item (what the agent just added): that one, whatever was shown before.
        if (focus && p.items.some((i) => i.id === focus)) setSelected(focus);
      })
      .catch((err: unknown) => live && setError(err instanceof HostApiError ? err.message : String(err)));
    const off = onHostEvent((e) => {
      if (e.type === "viewpack.upserted" && e.pack.id === packId) take(e.pack);
    });
    return () => {
      live = false;
      off();
    };
  }, [link, packId, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void viewerPinned().then(setPinned).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (pack) document.title = `${pack.title} · 查看包`;
  }, [pack?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <div className="placeholder">打不开这个查看包：{error}</div>;
  if (!pack) return <div className="placeholder">正在读取…</div>;
  const workspace = state.workspaces.find((w) => w.id === pack.workspaceId);
  if (!workspace) return <div className="placeholder">这个查看包的项目已经不在了。</div>;
  const item = pack.items.find((i) => i.id === selected) ?? pack.items[0]!;
  const from = pack.sessionId ? state.sessions.find((s) => s.id === pack.sessionId) : undefined;
  const view = VIEW_KIND_VIEWS[item.kind] as { View(p: ItemViewProps<ViewItemKind>): JSX.Element };
  const many = pack.items.length > 1;
  const step = (by: number) => {
    const i = pack.items.findIndex((x) => x.id === item.id);
    const next = pack.items[i + by];
    if (next) setSelected(next.id);
  };

  return (
    <div className="vw-app vp-app" data-testid="viewpack">
      <header className="vw-head" ref={head}>
        <div className="vw-title">
          <span className="vw-name" data-testid="viewpack-title">
            {pack.title}
          </span>
          <span className="vw-dir">
            {workspace.name}
            {from ? ` · 来自「${from.title || "未命名会话"}」` : ""}
          </span>
        </div>
        <div className="vw-actions">
          <button
            type="button"
            className="btn-ghost small vw-pin"
            aria-pressed={pinned}
            disabled={pinned}
            title={pinned ? "已固定：这个窗口会保留，之后打开的在新窗口里" : "固定这个窗口：之后打开的查看包和文件在新窗口里，这个窗口保留"}
            onClick={() =>
              void pinViewer()
                .then(setPinned)
                .catch((err: unknown) => showToast({ text: String(err), error: true }))
            }
            data-testid="viewer-pin"
          >
            {pinned ? "已固定" : "固定"}
          </button>
        </div>
      </header>
      <main className="vp-body">
        {many && (
          <nav
            className="vp-list"
            aria-label="查看包的内容"
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              step(e.key === "ArrowDown" ? 1 : -1);
            }}
          >
            {pack.items.map((i) => {
              const k = VIEW_KIND_VIEWS[i.kind];
              const detail = viewItemDetail(i);
              return (
                <button
                  key={i.id}
                  type="button"
                  className="vp-entry"
                  aria-current={i.id === item.id}
                  title={`${k.word}${detail ? ` · ${detail}` : ""}`}
                  onClick={() => setSelected(i.id)}
                  data-testid="viewpack-entry"
                  data-kind={i.kind}
                >
                  <span className="vp-entry-icon">{k.icon}</span>
                  <span className="vp-entry-text">
                    <span className="vp-entry-name">{viewItemLabel(i)}</span>
                    {detail && <span className="vp-entry-detail">{detail}</span>}
                  </span>
                </button>
              );
            })}
          </nav>
        )}
        <section className="vp-main" aria-label={viewItemLabel(item)}>
          <view.View key={item.id} link={link} state={state} pack={pack} workspace={workspace} item={item} nonce={`${nonce}:${pack.updatedAt}`} active />
        </section>
      </main>
    </div>
  );
}
