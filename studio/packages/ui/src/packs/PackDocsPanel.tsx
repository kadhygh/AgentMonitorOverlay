import { useState } from "react";
import type { HostLink } from "../host/client.js";
import { Markdown } from "../lib/markdown.js";
import { usePackDoc, usePacks } from "./usePacks.js";

/** "规范" on the task page: the documents of the extension packs in the task's workspaces, readable in place. */
export function PackDocsPanel({ link, workspaceIds }: { link: HostLink; workspaceIds: readonly string[] }) {
  const { packs } = usePacks(link, workspaceIds);
  const [open, setOpen] = useState<{ workspaceId: string; pack: string; doc: string } | null>(null);
  const { doc, error } = usePackDoc(link, open);
  const docs = packs.flatMap((p) => (p.manifest ? p.manifest.docs.map((d) => ({ ...d, workspaceId: p.workspaceId, pack: p.dirName, packTitle: p.manifest!.title })) : []));
  if (!docs.length) return null;
  const isOpen = (d: (typeof docs)[number]) => open?.workspaceId === d.workspaceId && open.pack === d.pack && open.doc === d.id;
  return (
    <section className="mail-panel" aria-label="规范">
      <div className="anno-head">
        <span className="anno-title">规范</span>
        <span className="anno-count">{docs.length}</span>
      </div>
      {docs.map((d) => (
        <button
          key={`${d.workspaceId}/${d.pack}/${d.id}`}
          type="button"
          className="pack-item clickable"
          aria-pressed={isOpen(d)}
          data-testid="task-pack-doc"
          onClick={() => setOpen(isOpen(d) ? null : { workspaceId: d.workspaceId, pack: d.pack, doc: d.id })}
        >
          <span className="pack-item-title">{d.title}</span>
          <span className="pack-item-sub">{d.packTitle}</span>
        </button>
      ))}
      {open && (
        <div className="pack-doc compact" data-testid="task-pack-doc-view">
          {error ? <span className="pack-bad">{error}</span> : doc ? <Markdown source={doc.text} /> : <span className="pack-path">读取中…</span>}
        </div>
      )}
    </section>
  );
}
