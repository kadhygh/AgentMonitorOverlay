import { useState } from "react";
import type { ModelProfile, WorkspacePack, Workspace } from "@amo-studio/protocol";
import type { HostLink } from "../host/client.js";
import { Markdown } from "../lib/markdown.js";
import { usePackDoc, usePacks } from "./usePacks.js";

/**
 * A workspace's extension packs (`.amo/packs`): documents to read, task templates and session presets. Read on
 * demand; "重新加载" after editing pack files. A pack with errors shows them instead of its content.
 */
export function PacksPage({ link, workspace, profiles }: { link: HostLink; workspace: Workspace; profiles: readonly ModelProfile[] }) {
  const { packs, error, loading, reload } = usePacks(link, [workspace.id]);
  const [selected, setSelected] = useState<string | null>(null);
  const [docId, setDocId] = useState<string | null>(null);
  const pack = packs.find((p) => p.dirName === selected) ?? packs[0] ?? null;
  const { doc, error: docError } = usePackDoc(link, pack && docId ? { workspaceId: workspace.id, pack: pack.dirName, doc: docId } : null);

  return (
    <section className="packs" aria-label="扩展包">
      <div className="page-head">
        <span className="page-crumb">{workspace.name} / 扩展包</span>
        <div className="spacer" />
        <button type="button" className="btn-ghost small" onClick={reload} disabled={loading}>
          重新加载
        </button>
      </div>
      {error && <div className="banner">{error}</div>}
      {!loading && !packs.length && !error && (
        <div className="placeholder" data-testid="packs-empty">
          <span>这个工作区还没有扩展包。</span>
          <span>
            在工作区里新建 <code>.amo/packs/&lt;名字&gt;/pack.json</code>，格式见 Studio 的 <code>design/pack-format.md</code>。
          </span>
        </div>
      )}
      {packs.length > 0 && (
        <div className="packs-body">
          <div className="packs-list" role="list">
            {packs.map((p) => (
              <button
                key={p.dirName}
                type="button"
                role="listitem"
                className="nav-row"
                aria-current={p === pack}
                data-testid="pack-row"
                onClick={() => {
                  setSelected(p.dirName);
                  setDocId(null);
                }}
              >
                <span className="name">{p.manifest?.title ?? p.dirName}</span>
                {p.errors.length > 0 && <span className="pack-bad">有错误</span>}
              </button>
            ))}
          </div>
          {pack && (
            <div className="packs-detail" data-testid="pack-detail">
              {/* A document replaces the pack's overview while it is open, so it is read from the top. */}
              {docId ? (
                <div className="pack-doc" data-testid="pack-doc">
                  <div className="anno-head">
                    <button type="button" className="link-btn boxed" onClick={() => setDocId(null)}>
                      ← {pack.manifest?.title ?? pack.dirName}
                    </button>
                    <span className="anno-title">{doc?.title ?? "文档"}</span>
                    {doc && <span className="pack-path">{doc.path}</span>}
                  </div>
                  {docError ? <div className="banner">{docError}</div> : doc ? <Markdown source={doc.text} /> : <span className="pack-path">读取中…</span>}
                </div>
              ) : (
                <PackDetail pack={pack} profiles={profiles} docId={docId} onDoc={setDocId} />
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function PackDetail({ pack, profiles, docId, onDoc }: { pack: WorkspacePack; profiles: readonly ModelProfile[]; docId: string | null; onDoc(id: string): void }) {
  const m = pack.manifest;
  return (
    <>
      <div className="pack-head">
        <span className="pack-title">{m?.title ?? pack.dirName}</span>
        <span className="pack-path">.amo/packs/{pack.dirName}</span>
      </div>
      {m?.description && <p className="pack-desc">{m.description}</p>}
      {pack.errors.length > 0 && (
        <ul className="pack-problems error" data-testid="pack-errors">
          {pack.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {pack.warnings.length > 0 && (
        <ul className="pack-problems" data-testid="pack-warnings">
          {pack.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      {m && (
        <>
          <PackSection title="规范" count={m.docs.length}>
            {m.docs.map((d) => (
              <button key={d.id} type="button" className="pack-item clickable" aria-pressed={docId === d.id} onClick={() => onDoc(d.id)} data-testid="pack-doc-link">
                <span className="pack-item-title">{d.title}</span>
                {d.summary && <span className="pack-item-sub">{d.summary}</span>}
              </button>
            ))}
          </PackSection>
          <PackSection title="流程模板" count={m.templates.length}>
            {m.templates.map((t) => (
              <div key={t.id} className="pack-item" data-testid="pack-template">
                <span className="pack-item-title">
                  {t.title}
                  {t.titlePrefix && <span className="pack-item-sub"> · 标题前缀 {t.titlePrefix.trim()}</span>}
                </span>
                {t.description && <span className="pack-item-sub">{t.description}</span>}
                <ol className="pack-steps">
                  {t.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </div>
            ))}
          </PackSection>
          <PackSection title="启动预设" count={m.presets.length}>
            {m.presets.map((p) => {
              const profile = p.profile ? profiles.find((x) => x.id === p.profile) : undefined;
              return (
                <div key={p.id} className="pack-item" data-testid="pack-preset">
                  <span className="pack-item-title">{p.title}</span>
                  <span className="pack-item-sub">
                    模型：{p.profile ? (profile ? profile.label : `${p.profile}（没有这个配置，会用默认模型）`) : "默认"}
                    {p.contextFiles?.length ? ` · 相关文件 ${p.contextFiles.length} 个` : ""}
                  </span>
                  <pre className="pack-prompt">{p.prompt}</pre>
                </div>
              );
            })}
          </PackSection>
          {m.tools.length > 0 && (
            <PackSection title="专用工具（预留，不会运行）" count={m.tools.length}>
              {m.tools.map((t) => (
                <div key={t.name} className="pack-item">
                  <span className="pack-item-title">{t.name}</span>
                  {t.description && <span className="pack-item-sub">{t.description}</span>}
                </div>
              ))}
            </PackSection>
          )}
        </>
      )}
    </>
  );
}

function PackSection({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (!count) return null;
  return (
    <div className="pack-section">
      <div className="anno-head">
        <span className="anno-title">{title}</span>
        <span className="anno-count">{count}</span>
      </div>
      {children}
    </div>
  );
}
