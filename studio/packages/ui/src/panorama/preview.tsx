import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { PanoramaInput } from "./datalayer.js";
import { PanoramaPage } from "./PanoramaPage.js";
import { DEFAULT_THEME, lookFrom, PREVIEW_LOOK, type PanoramaTheme } from "./themes.js";
import "./panorama.css";

// 全景's preview outside Studio (P1, 2026-11-02): the same page, layout and drawing as the 全景 tab, fed a snapshot of
// real data instead of the Host, so the person can look at it from another device (http://100.107.87.64:47130/ serves
// studio/plans/userlayer/) without Studio being restarted. Built by studio/plans/userlayer/panorama-build.mjs; the
// snapshot is written by panorama-snapshot.mjs (structure and titles only, read from the Host without changing it).

/** The datalayer's input as it was when the snapshot was taken (AMO's shapes are the datalayer's business). */
export type PanoramaSnapshot = Omit<PanoramaInput, "now"> & Required<Pick<PanoramaInput, "profiles" | "checklist" | "dependencies">> & {
  takenAt: string;
  /** Set on a made-up variant (data changed by hand to show what the real data lacks): what was changed. */
  demo?: string;
};

/**
 * The look to try, from the address (themes.ts lookFrom): #base (how P1 first looked), #a, #ab, #ad, #abd; with -flow,
 * -spiral, -wave or -line (straight, the default since 11-03) the front, folding, the fixed footprint and topic blocks come
 * along (-nofront, -nofold, -nospan, -noblocks leave one out).
 * Nothing (or what is not understood): PREVIEW_LOOK.
 */
function lookName(): string {
  const h = decodeURIComponent(location.hash.slice(1));
  return h && lookFrom(h) ? h : PREVIEW_LOOK;
}

function Preview() {
  const [look, setLook] = useState(lookName);
  useEffect(() => {
    const on = () => setLook(lookName());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const theme: PanoramaTheme = { ...DEFAULT_THEME, look: lookFrom(look)! };
  const [snap, setSnap] = useState<PanoramaSnapshot | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  useEffect(() => {
    const src = new URLSearchParams(location.search).get("data") || "panorama-snapshot.json";
    fetch(src, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${src}: ${r.status}`))))
      .then((s: PanoramaSnapshot) => setSnap(s))
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(""), 2600);
    return () => clearTimeout(t);
  }, [note]);
  if (error) return <div className="pn-preview-msg">读不到快照：{error}</div>;
  if (!snap) return <div className="pn-preview-msg">正在读快照…</div>;
  const taken = new Date(snap.takenAt);
  return (
    <>
      <PanoramaPage
        key={look}
        theme={theme}
        topic={snap.topic}
        tasks={snap.tasks}
        sessions={snap.sessions}
        profiles={snap.profiles}
        checklist={snap.checklist}
        dependencies={snap.dependencies}
        topics={snap.topics}
        workspaces={snap.workspaces}
        docs={snap.docs}
        reviews={snap.reviews}
        extra={snap.extra}
        loose={snap.loose}
        now={snap.takenAt}
        onOpenTask={() => setNote("这是预览：打开任务要在 Studio 里")}
      />
      <div className="pn-preview-tag">
        预览 #{look} · 快照 {taken.getMonth() + 1}-{String(taken.getDate()).padStart(2, "0")} {taken.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}
        {snap.demo && <div className="pn-preview-demo">{snap.demo}</div>}
      </div>
      {note && <div className="pn-preview-note">{note}</div>}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
