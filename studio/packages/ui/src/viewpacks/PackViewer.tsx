import { useEffect, useRef, useState, type JSX } from "react";
import { viewItemDetail, viewItemLabel, type StateSnapshot, type ViewItemKind, type ViewPack } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { showToast } from "../lib/toast.js";
import { pinViewer, viewerPinned } from "../viewer/open.js";
import { useFitWidth } from "../lib/fitWidth.js";
import { itemToShow } from "./logic.js";
import { VIEW_KIND_VIEWS, type ItemViewProps } from "./kinds.js";
import { TitleMark, WindowControls, WindowPlaceholder } from "../shell/WindowControls.js";
import { RemoteStaleBar, remoteWorkspace, type RemoteReview } from "../remote/reviewer.js";

// The 查看包 window (2026-10-23): the viewer window showing a pack — its items in a list on the left, the one picked
// on the right, drawn by its kind (kinds.tsx). The pack is read from the Host and followed: when the agent adds to
// it, the window shows what was added. Reused for the next pack until 固定, as the viewer is.

export function PackViewer({ link, state, packId, focus, nonce, remote = null }: { link: HostLink; state: StateSnapshot; packId: string; focus: string | null; nonce: string; /** 远程 Reviewer (2026-11-02): a remote task's pack; `link` goes to its computer. */ remote?: RemoteReview | null }) {
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const head = useRef<HTMLElement>(null);
  useFitWidth(head);

  // The pack as read (with the item it was opened at) or as its last event brought it; read again after a reconnect.
  const [got] = useLiveResource<{ pack: ViewPack; focus: string | null } | null>(
    {
      load: () => {
        setError(null);
        // Opened at an item (what the agent just added): that one, whatever was shown before.
        return call(link, "GET /api/viewpacks/:id", { id: packId }).then((p) => ({ pack: p, focus: focus && p.items.some((i) => i.id === focus) ? focus : null }));
      },
      initial: null,
      onEvent: (cur, e) => (e.type === "viewpack.upserted" && e.pack.id === packId ? { pack: e.pack, focus: null } : cur),
      onError: (err) => setError(err instanceof HostApiError ? err.message : String(err)),
    },
    [link, packId, nonce],
  );
  const pack = got?.pack ?? null;
  // What to show follows each new version of the pack: what was just added, else what was shown (itemToShow).
  const [seen, setSeen] = useState<typeof got>(null);
  if (got && got !== seen) {
    setSeen(got);
    setSelected((cur) => got.focus ?? itemToShow(seen && seen.pack.id === got.pack.id ? seen.pack : null, got.pack, cur));
  }

  useEffect(() => {
    void viewerPinned().then(setPinned).catch(() => undefined);
  }, []);

  // j / k through the list, as through Git Review's files (2026-10-23): the leftmost list takes them; a git item's
  // own files go by Ctrl+J / Ctrl+K then.
  useEffect(() => {
    if (!pack || pack.items.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const k = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey || e.altKey || (k !== "j" && k !== "k") || el?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      setSelected((cur) => {
        const i = Math.max(0, pack.items.findIndex((x) => x.id === cur));
        const next = pack.items[k === "j" ? Math.min(pack.items.length - 1, i + 1) : Math.max(0, i - 1)];
        return next?.id ?? cur;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pack]);
  useEffect(() => {
    if (pack) document.title = `${pack.title} · 查看包`;
  }, [pack?.title]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <WindowPlaceholder title="查看包">打不开这个查看包：{error}</WindowPlaceholder>;
  if (!pack) return <WindowPlaceholder title="查看包">{remote ? `正在从 ${remote.device} 读取…` : "正在读取…"}</WindowPlaceholder>;
  // A remote task's project is not here: a stand-in named by its computer (paths start at 任务文件夹).
  const workspace = remote ? remoteWorkspace(pack.workspaceId, remote.device) : state.workspaces.find((w) => w.id === pack.workspaceId);
  if (!workspace) return <WindowPlaceholder title={pack.title}>这个查看包的项目已经不在了。</WindowPlaceholder>;
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
      {/* The window's title bar (2026-10-29): it drags the window and ends with the window buttons. */}
      <header className="vw-head titlebar" ref={head}>
        <TitleMark />
        <div className="vw-title">
          <span className="vw-name" data-testid="viewpack-title">
            {pack.title}
          </span>
          <span className={remote ? "vw-dir vw-dir-remote" : "vw-dir"} data-testid="viewpack-where">
            {remote && <span className="remote-badge">远程</span>} {workspace.name}
            {from ? ` · 来自「${from.title || "未命名会话"}」` : ""}
          </span>
        </div>
        <div className="vw-actions">
          <button
            type="button"
            className="btn-ghost small vw-pin"
            aria-pressed={pinned}
            disabled={pinned}
            title={pinned ? "已锁定：这个窗口会保留，之后打开的在新窗口里" : "锁定这个窗口：之后打开的查看包和文件在新窗口里，这个窗口保留"}
            onClick={() =>
              void pinViewer()
                .then(setPinned)
                .catch((err: unknown) => showToast({ text: String(err), error: true }))
            }
            data-testid="viewer-pin"
          >
            {pinned ? "已锁定" : "锁定"}
          </button>
        </div>
        <WindowControls pin />
      </header>
      {remote && <RemoteStaleBar taskId={remote.taskId} />}
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
            <div className="vp-list-keys" data-testid="viewpack-keys">
              <kbd className="gr-key">J</kbd>
              <kbd className="gr-key">K</kbd> 切换条目
              {item.kind === "git" && (
                <>
                  <br />
                  <kbd className="gr-key">Ctrl J</kbd>
                  <kbd className="gr-key">Ctrl K</kbd> 切换里面的文件
                </>
              )}
            </div>
          </nav>
        )}
        <section className="vp-main" aria-label={viewItemLabel(item)}>
          <view.View key={item.id} link={link} state={state} pack={pack} workspace={workspace} item={item} nonce={`${nonce}:${pack.updatedAt}`} active />
        </section>
      </main>
    </div>
  );
}
