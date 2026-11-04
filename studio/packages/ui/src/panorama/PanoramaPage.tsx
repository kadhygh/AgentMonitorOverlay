import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ITEM_LABEL, needsYou, toPanorama, type ItemStatus, type PanoramaData, type PanoramaDoc, type PanoramaInput, type PanoramaItem } from "./datalayer.js";
import { DEFAULT_THEME, type PanoramaTheme } from "./themes.js";
import type { EngineProbe, PanoramaEngine } from "./engine.js";
import { readStored } from "../lib/stored.js";

// 全景 (设置 → 测试功能, 2026-11-01): a topic's tasks as lanes on a tilted map (the userlayer), drawn only from the
// datalayer (datalayer.ts), never from Studio's state directly. The map itself (engine.ts, deck.gl) is loaded on first
// use; when WebGL cannot start the page shows the same data as a plain list instead of a blank area.
//
// The same page runs outside Studio as the preview (preview.tsx, studio/plans/userlayer/panorama-preview.html) on a
// snapshot of real data: everything it shows comes in through its props, handed straight to the datalayer (the only
// part that knows AMO's types), and what it asks of AMO goes out through onOpenTask.

const SYM: Record<ItemStatus, string> = { needs_you: "!", working: "◐", waiting: "○", settled: "✓", parked: "–" };
/** The popup is this wide; the map keeps that much clear on the right when it frames something. */
const WIN_W = 380;

declare global {
  interface Window {
    /** For the e2e test: where nodes are on screen and whether the camera is still moving (it clicks with the mouse). */
    __panorama?: EngineProbe;
  }
}

/** WebGL2 is what deck.gl 9 needs; asked once on a throwaway canvas, which is let go at once. */
function webglAvailable(): boolean {
  // For checking the list without breaking WebGL (e2e): localStorage amo.panorama.noWebgl = "1".
  if (readStored("amo.panorama.noWebgl") === "1") return false;
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    if (!gl) return false;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function timeText(iso: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  return d.toDateString() === new Date().toDateString() ? `今天 ${hm}` : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${hm}`;
}

export function PanoramaPage({
  topic,
  tasks,
  sessions,
  profiles,
  checklist,
  dependencies,
  topics,
  workspaces,
  docs,
  reviews,
  extra,
  loose,
  now,
  theme = DEFAULT_THEME,
  looks,
  onLook,
  onOpenTask,
}: Omit<PanoramaInput, "now"> & Required<Pick<PanoramaInput, "profiles" | "checklist" | "dependencies">> & {
  /** Its looks (the preview tries variants of them); Studio's default when left out. */
  theme?: PanoramaTheme;
  /** The time the data is from (the preview's snapshot); now when left out. */
  now?: string;
  /** Studio (11-04): the looks to switch between in the corner, the current one being `theme`'s. */
  looks?: readonly { id: string; label: string }[];
  onLook?(id: string): void;
  /** What AMO does for 全景: open a task (on a session). */
  onOpenTask(taskId: string, sessionId?: string): void;
}) {
  const data = useMemo(
    () => toPanorama({ topic, tasks, sessions, profiles, checklist, dependencies, topics, workspaces, docs, reviews, extra, loose, now: now ?? new Date().toISOString() }),
    [topic, tasks, sessions, profiles, checklist, dependencies, topics, workspaces, docs, reviews, extra, loose, now],
  );
  const dataRef = useRef<PanoramaData>(data);
  dataRef.current = data;
  const need = useMemo(() => needsYou(data), [data]);
  const [mode, setMode] = useState<"loading" | "map" | "list">(() => (webglAvailable() ? "loading" : "list"));
  const [sel, setSel] = useState<string | null>(null);
  // Runs of rounds opened by a click (look `fold`): the page's, not the data's.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const mapRef = useRef<HTMLDivElement>(null);
  const readoutRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<PanoramaEngine | null>(null);

  // The map: made once per page (the view gives each topic its own page), torn down when the page goes.
  useEffect(() => {
    if (mode === "list") return;
    let gone = false;
    let ready = false;
    let engine: PanoramaEngine | null = null;
    const fail = () => {
      clearTimeout(slow);
      engine?.destroy();
      engineRef.current = null;
      if (!gone) setMode("list");
    };
    // A map that has not drawn after 15 s (the graphics device never came up) gives way to the list.
    const slow = window.setTimeout(() => !ready && fail(), 15_000);
    import("./engine.js")
      .then(({ PanoramaEngine }) => {
        if (gone || !mapRef.current) return;
        engine = new PanoramaEngine(mapRef.current, theme, dataRef.current, {
          onPick: (id) => setSel(id),
          onFold: (key) =>
            setOpen((cur) => {
              const next = new Set(cur);
              if (!next.delete(key)) next.add(key);
              return next;
            }),
          onReady: () => {
            ready = true;
            clearTimeout(slow);
            if (!gone) setMode("map");
          },
          onError: fail,
          // Straight into the element: the readout changes with every camera step, not worth a React render.
          onView: (line) => {
            if (readoutRef.current) readoutRef.current.textContent = line;
          },
        });
        engine.setInset(WIN_W + 18);
        engineRef.current = engine;
        window.__panorama = engine.probe();
      })
      .catch(fail);
    return () => {
      gone = true;
      clearTimeout(slow);
      engine?.destroy();
      engineRef.current = null;
      delete window.__panorama;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per page; data goes in through setData below
  }, [mode === "list"]);

  useEffect(() => engineRef.current?.setData(data), [data]);
  useEffect(() => engineRef.current?.setOpen(open), [open]);

  // A selection that no longer exists (the session was archived away, the task left the topic) closes its popup. 0.3:
  // a document on a topic's shelf is selected the same way.
  const item = sel ? data.items.find((i) => i.id === sel) : undefined;
  const doc = sel && !item ? data.docs.find((d) => d.id === sel) : undefined;
  useEffect(() => {
    if (sel && !item && !doc) setSel(null);
  }, [sel, item, doc]);

  // The selection drives the map: its ring and bright sign, and the camera flies to it.
  useEffect(() => engineRef.current?.select(sel, !!sel), [sel]);

  const nextNeed = () => {
    if (!need.length) return;
    const cur = need.findIndex((n) => n.id === sel);
    setSel(need[(cur + 1) % need.length]!.id);
  };

  useEffect(() => {
    if (!sel) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, [contenteditable]")) return;
      setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel]);

  const lane = item?.lane ? data.lanes.find((l) => l.id === item.lane) : undefined;
  const curNeed = need.findIndex((n) => n.id === sel);
  const nSessions = data.items.filter((i) => i.type === "session").length;
  const topicOf = (id: string) => data.topics.find((t) => t.id === id);
  // Where an item stands, for its popup: its task, or its topic's spine or board.
  const where = (it: PanoramaItem) => {
    const l = it.lane ? data.lanes.find((x) => x.id === it.lane) : undefined;
    if (l) return l.title;
    return `${topicOf(it.topic)?.title ?? ""} · ${it.type === "session" ? "主控（专题自己的会话）" : "公告板"}`;
  };
  const nextOrNull = (id: string) => (need.length > 1 || (need.length === 1 && need[0]!.id !== id) ? nextNeed : null);

  return (
    <div className="panorama" data-theme={theme.id} data-mode={mode} style={theme.css as CSSProperties} data-testid="panorama">
      {mode === "list" ? (
        <PanoramaList data={data} onOpenTask={onOpenTask} />
      ) : (
        <>
          <div className="pn-bg" />
          <div className="pn-map" ref={mapRef} data-testid="panorama-map" />
          <div className="pn-fx" />
          <div className="pn-fx2" />
          <div className="pn-hud pn-title">
            <span className="pn-k">{data.topics.length > 1 ? `全景 · ${data.topics.length} 个专题` : "全景 · 专题"}</span>
            <span className="pn-ttl" title={data.topics.map((t) => t.title).join("\n")}>
              {data.topics.length > 1 ? "全部专题" : (data.topics[0]?.title ?? data.context.title)}
            </span>
            <span className="pn-row">
              {data.lanes.length} 个任务 · {nSessions} 个会话
              {data.projects.length > data.topics.length ? ` · ${data.projects.length} 个项目` : ""}
            </span>
          </div>
          <div className="pn-hud pn-readout" ref={readoutRef} aria-hidden="true" />
          <div className="pn-hud pn-tr">
            <button type="button" className={`pn-need${need.length ? "" : " none"}`} onClick={nextNeed} data-testid="panorama-need">
              <span className="big">{need.length ? `! ${need.length} 件等你` : "✓ 没有等你的事"}</span>
              <span className="sub">{need.length ? (curNeed >= 0 ? `第 ${curNeed + 1}/${need.length} 件 · 再点下一件` : `先看：${need[0]!.short}`) : "会话都不在等你"}</span>
            </button>
          </div>
          <div className="pn-hud pn-br">
            {looks && onLook && looks.length > 1 && (
              <span className="pn-looks" role="group" aria-label="样式">
                {looks.map((l) => (
                  <button key={l.id} type="button" aria-pressed={l.id === theme.id} onClick={() => onLook(l.id)} title={`换成${l.label}样式（记在本机）`}>
                    {l.label}
                  </button>
                ))}
              </span>
            )}
            <button type="button" onClick={() => engineRef.current?.zoomBy(1)} title="放大" aria-label="放大">
              +
            </button>
            <button type="button" onClick={() => engineRef.current?.zoomBy(-1)} title="缩小" aria-label="缩小">
              −
            </button>
            <button type="button" onClick={() => engineRef.current?.flyHome()} title={data.topics.length > 1 ? "看全部（双击空白处也行）" : "看整个专题（双击空白处也行）"}>
              重置视角
            </button>
          </div>
          {mode === "loading" && <div className="pn-loading">正在画全景…</div>}
          {!data.lanes.length && <div className="pn-loading">{data.topics.length > 1 ? "这些专题还没有任务。" : "这个专题还没有任务。"}</div>}
          {item && item.type === "session" && (lane || !item.lane) && (
            <PanoramaWindow
              item={item}
              from={item.forkFrom ? data.items.find((i) => i.id === item.forkFrom) : undefined}
              laneTitle={where(item)}
              next={nextOrNull(item.id)}
              onOpenTask={item.ref.taskId ? () => onOpenTask(item.ref.taskId, item.ref.sessionId) : null}
              onClose={() => setSel(null)}
            />
          )}
          {item && item.type !== "session" && (
            <PointWindow
              item={item}
              of={item.of ? data.items.find((i) => i.id === item.of) : undefined}
              where={where(item)}
              next={nextOrNull(item.id)}
              onOpenTask={item.ref.taskId ? () => onOpenTask(item.ref.taskId, item.ref.sessionId || undefined) : null}
              onClose={() => setSel(null)}
            />
          )}
          {doc && <DocWindow doc={doc} topic={topicOf(doc.topic)?.title ?? ""} projects={data.projects.filter((x) => x.topic === doc.topic).map((x) => x.title)} onClose={() => setSel(null)} />}
        </>
      )}
    </div>
  );
}

/** The popup of a node: the least to know what it is, and the way to its task. */
function PanoramaWindow({ item, from, laneTitle, next, onOpenTask, onClose }: { item: PanoramaItem; from: PanoramaItem | undefined; laneTitle: string; next: (() => void) | null; onOpenTask: (() => void) | null; onClose(): void }) {
  // A branch says which round it came from (0: from another branch).
  const forkRound = item.forkFrom ? (from?.round ?? 0) : undefined;
  const need = item.status === "needs_you";
  return (
    <div className={`pn-win${need ? " need" : ""}`} role="dialog" aria-label={`#${item.num} ${item.title}`} data-testid="panorama-window" style={{ width: WIN_W }}>
      <div className="pn-bar">
        <span>#{item.num} · {item.round !== null ? `第 ${item.round} 轮` : item.ref.how === "fork" ? "分支会话" : "分支"}</span>
        <span className="pn-st">
          {SYM[item.status]} {item.ref.statusLabel}
        </span>
        <button type="button" className="pn-x" onClick={onClose} title="Esc">
          ✕ 关闭
        </button>
      </div>
      <div className="pn-in">
        <h2>{item.title}</h2>
        <div className="pn-meta">
          <span>{item.lane ? "任务" : "专题"}</span>
          <span>{laneTitle}</span>
          {forkRound !== undefined && (
            <>
              <span>来自</span>
              <span>{forkRound ? `第 ${forkRound} 轮${item.ref.how === "fork" ? "分出的分支会话" : "开的会话"}` : "另一条分支"}</span>
            </>
          )}
          <span>状态</span>
          <span>{item.summary}</span>
          {item.ref.model && (
            <>
              <span>模型</span>
              <span>{item.ref.model}</span>
            </>
          )}
          <span>开始</span>
          <span>{timeText(item.at)}</span>
        </div>
        <div className="pn-acts">
          {onOpenTask && (
            <button type="button" className="pn-btn primary" onClick={onOpenTask} data-testid="panorama-open-task">
              打开任务
            </button>
          )}
          {next && (
            <button type="button" className="pn-btn nx" onClick={next}>
              下一件等你的 →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 0.3: the popup of a point (决定、问题、发现、便签): what it says, where it came from, and the way to its session. */
function PointWindow({ item, of, where, next, onOpenTask, onClose }: { item: PanoramaItem; of: PanoramaItem | undefined; where: string; next: (() => void) | null; onOpenTask: (() => void) | null; onClose(): void }) {
  const need = item.status === "needs_you";
  return (
    <div className={`pn-win${need ? " need" : ""}`} role="dialog" aria-label={`${ITEM_LABEL[item.type]} ${item.title}`} data-testid="panorama-point" style={{ width: WIN_W }}>
      <div className="pn-bar">
        <span>{ITEM_LABEL[item.type]}</span>
        <span className="pn-st">
          {SYM[item.status]} {need ? "等你" : item.summary}
        </span>
        <button type="button" className="pn-x" onClick={onClose} title="Esc">
          ✕ 关闭
        </button>
      </div>
      <div className="pn-in">
        <h2>{item.title}</h2>
        {item.body && <p className="pn-body">{item.body}</p>}
        <div className="pn-meta">
          <span>在</span>
          <span>{where}</span>
          {of && (
            <>
              <span>来自</span>
              <span>{of.round !== null ? `第 ${of.round} 轮 · ${of.title}` : of.title}</span>
            </>
          )}
          <span>时间</span>
          <span>{timeText(item.at)}</span>
        </div>
        <div className="pn-acts">
          {onOpenTask && (
            <button type="button" className="pn-btn primary" onClick={onOpenTask}>
              打开会话
            </button>
          )}
          {next && (
            <button type="button" className="pn-btn nx" onClick={next}>
              下一件等你的 →
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** 0.3: the popup of a document on a topic's shelf: its first lines (the preview has no way to open it in full yet). */
function DocWindow({ doc, topic, projects, onClose }: { doc: PanoramaDoc; topic: string; projects: string[]; onClose(): void }) {
  return (
    <div className="pn-win" role="dialog" aria-label={doc.title} data-testid="panorama-doc" style={{ width: WIN_W }}>
      <div className="pn-bar">
        <span>{doc.kind === "spec" ? "专题规范" : "专题文档"}</span>
        <span className="pn-st">更新 {timeText(doc.updatedAt)}</span>
        <button type="button" className="pn-x" onClick={onClose} title="Esc">
          ✕ 关闭
        </button>
      </div>
      <div className="pn-in">
        <h2>{doc.title}</h2>
        <p className="pn-body">{doc.summary || "快照里没带正文，只有标题。"}</p>
        <div className="pn-meta">
          <span>专题</span>
          <span>{topic}</span>
          {doc.kind === "spec" && projects.length > 0 && (
            <>
              <span>适用</span>
              <span>{projects.join("、")}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Without WebGL: the same data as a list (tasks, their sessions, what waits for you first). */
function PanoramaList({ data, onOpenTask }: { data: PanoramaData; onOpenTask(taskId: string, sessionId?: string): void }) {
  const need = needsYou(data);
  return (
    <div className="pn-list" data-testid="panorama-list">
      <p className="pn-list-note">这台电脑上画不了全景（WebGL 没有启动），先用列表看。</p>
      {need.length > 0 && (
        <section>
          <h3>! {need.length} 件等你</h3>
          {need.map((i) => (
            <button key={i.id} type="button" className="pn-li need" onClick={() => onOpenTask(i.ref.taskId, i.ref.sessionId)}>
              <span>! {i.summary}</span> {i.title} <span className="dim">· {data.lanes.find((l) => l.id === i.lane)?.title}</span>
            </button>
          ))}
        </section>
      )}
      {data.lanes.map((l) => (
        <section key={l.id}>
          <h3>
            <button type="button" className="pn-li lane" onClick={() => onOpenTask(l.ref.taskId)}>
              {l.title}
            </button>
          </h3>
          {data.items
            .filter((i) => i.lane === l.id)
            .map((i) => (
              <button key={i.id} type="button" className={`pn-li${i.status === "needs_you" ? " need" : ""}`} onClick={() => onOpenTask(i.ref.taskId, i.ref.sessionId)}>
                <span>{SYM[i.status]}</span> {i.title} <span className="dim">· {i.summary}</span>
              </button>
            ))}
        </section>
      ))}
      {!data.lanes.length && <p className="pn-list-note">这个专题还没有任务。</p>}
    </div>
  );
}
