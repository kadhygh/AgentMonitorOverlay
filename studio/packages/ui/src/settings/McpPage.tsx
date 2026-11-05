import { useCallback, useEffect, useState } from "react";
import { MCP_SECRET_MASK, mcpSummary, type McpChoices, type McpState, type StudioMcpServer } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { ChoiceChips, EntryLine, parsePasted, useMcpChanges } from "../mcp/shared.js";

// 设置 → MCP (2026-11-04, plans/done/mcp.md): the MCP servers sessions get besides Studio's own amo. Studio's list (pasted
// JSON, secrets kept in the Windows credential store), the person's own Claude Code servers, and whether each is on by
// default; projects and sessions can still turn one on or off (编辑项目, the composer's MCP button).

const EXAMPLE = `{
  "mcpServers": {
    "figma": { "type": "http", "url": "https://mcp.figma.com/mcp" }
  }
}`;

export function McpPage({ link }: { link: HostLink }) {
  const [state, setState] = useState<McpState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<StudioMcpServer | "new" | null>(null);

  const reload = useCallback(() => {
    call(link, "GET /api/mcp")
      .then(setState)
      .catch((err: unknown) => setError(err instanceof HostApiError ? err.message : String(err)));
  }, [link]);
  useEffect(reload, [reload]);
  useMcpChanges(reload);

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      reload();
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const setGlobal = (body: { loadLocal?: boolean; choices?: McpChoices }) => run(() => call(link, "PUT /api/mcp", {}, body));
  if (!state) return <section className="settings-section">{error ? <span className="form-error">{error}</span> : <span className="settings-hint">正在读取…</span>}</section>;
  const own = state.entries.filter((e) => e.source !== "studio");

  return (
    <>
      <section className="settings-section" aria-label="MCP">
        <span className="settings-heading">MCP</span>
        <span className="settings-hint">
          会话除了 Studio 自带的 amo，还能用哪些 MCP。这里是全局的默认；某个项目可以在「编辑项目」里另外开关，某个会话可以在输入框上方的「MCP」按钮里开关。改了以后，正在运行的 Claude 会话下一次调用工具就能用上 Studio 里加的；换掉本机配置的那几个，要等这一轮回复结束后从下一条消息起生效。DeepSeek 会话从下一条消息起生效。Codex 只用 Studio 里加的、全局开着的，要等 Codex 下次启动（比如重启 Studio）才生效，也不能按项目或会话开关。
        </span>
        <label className="settings-row feature-row">
          <input type="checkbox" checked={state.loadLocal} disabled={busy} onChange={(e) => void setGlobal({ loadLocal: e.target.checked })} data-testid="mcp-load-local" />
          <span className="feature-text">
            <span className="settings-label">加载本机已配置的 MCP</span>
            <span className="settings-hint">
              和在终端里开 Claude Code 一样：读 <code>{state.claudeConfig || "~/.claude.json"}</code> 里的 MCP（<code>claude mcp add</code> 加的就在这里）和项目里的 <code>.mcp.json</code>。Studio 只读这些文件，不会改。关掉后只用下面 Studio 里加的。
            </span>
          </span>
        </label>
      </section>

      <section className="settings-section" aria-label="Studio 的 MCP">
        <div className="settings-row">
          <span className="settings-heading">Studio 里加的</span>
          <span className="spacer" />
          {editing === null && (
            <button type="button" className="btn-ghost small" onClick={() => setEditing("new")} disabled={busy} data-testid="mcp-add">
              添加 MCP
            </button>
          )}
        </div>
        <span className="settings-hint">三种模型都能用。也可以直接在会话里跟 AI 说「帮我接入 xxx MCP」，它会把配置发给你确认后加进来。密钥存在 Windows 凭据管理器里，AI 看不到。</span>
        {editing === "new" && <ServerForm link={link} onDone={() => (setEditing(null), reload())} />}
        <div className="mcp-list">
          {state.servers.length === 0 && editing !== "new" && <span className="settings-hint">还没有。</span>}
          {state.servers.map((s) => {
            const entry = state.entries.find((e) => e.serverId === s.id);
            if (editing !== "new" && editing?.id === s.id) return <ServerForm key={s.id} link={link} server={s} onDone={() => (setEditing(null), reload())} />;
            return (
              <EntryLine key={s.id} entry={entry ?? { name: s.name, source: "studio", summary: mcpSummary(s.spec), on: s.on, inherited: s.on, ...(s.note ? { note: s.note } : {}) }}>
                <span className="mcp-actions">
                  <label className="settings-hint" title="不勾：只在单独打开它的项目或会话里用">
                    <input type="checkbox" checked={s.on} disabled={busy} onChange={(e) => void run(() => call(link, "PATCH /api/mcp/servers/:id", { id: s.id }, { on: e.target.checked }))} data-testid={`mcp-default-${s.name}`} /> 默认启用
                  </label>
                  <button type="button" className="btn-ghost small" disabled={busy} onClick={() => setEditing(s)} data-testid={`mcp-edit-${s.name}`}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn-ghost small"
                    disabled={busy}
                    onClick={() => window.confirm(`删掉 MCP「${s.name}」？用到它的会话从下次启动起就没有了。`) && void run(() => call(link, "DELETE /api/mcp/servers/:id", { id: s.id }))}
                    data-testid={`mcp-remove-${s.name}`}
                  >
                    删除
                  </button>
                </span>
              </EntryLine>
            );
          })}
        </div>
      </section>

      {state.loadLocal && (
        <section className="settings-section" aria-label="本机配置的 MCP">
          <span className="settings-heading">本机配置的</span>
          <span className="settings-hint">
            你的 Claude Code 里配置的用户级 MCP，以及 Claude 会话里见过的（插件、claude.ai 连接器等）。只属于某个项目的，在那个项目的「编辑项目」里看。「默认」是没人改过时的样子：<code>amo-relay</code> 和 Studio 自带的中转功能重复，默认不启用。
          </span>
          <div className="mcp-list">
            {own.length === 0 && <span className="settings-hint">没有找到。</span>}
            {own.map((e) => (
              <EntryLine key={e.name} entry={e}>
                <ChoiceChips entry={e} aboveLabel="默认" disabled={busy} onChange={(choice) => void setGlobal({ choices: { [e.name]: choice } })} />
              </EntryLine>
            ))}
          </div>
        </section>
      )}
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}

/** Adding (no server) or editing one of Studio's servers: a name and the pasted JSON. */
function ServerForm({ link, server, onDone }: { link: HostLink; server?: StudioMcpServer; onDone(): void }) {
  const [name, setName] = useState(server?.name ?? "");
  const [json, setJson] = useState(server ? JSON.stringify(server.spec, null, 2) : "");
  const [note, setNote] = useState(server?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const found = parsePasted(json);
      if (server) {
        if (found.length !== 1) throw new Error("编辑时只能放一个 MCP 的配置");
        await call(link, "PATCH /api/mcp/servers/:id", { id: server.id }, { name: name.trim(), spec: found[0]!.spec, note });
      } else {
        // Several servers pasted at once (a whole mcpServers block): each under its own name.
        if (found.length > 1 && name.trim()) throw new Error("粘贴了好几个 MCP：名字留空，各用 JSON 里的名字");
        for (const f of found) {
          const n = found.length === 1 ? name.trim() || f.name : f.name;
          if (!n) throw new Error("给它起个名字（英文字母、数字、_ 和 -）");
          await call(link, "POST /api/mcp/servers", {}, { name: n, spec: f.spec, ...(note ? { note } : {}) });
        }
      }
      onDone();
    } catch (err) {
      setError(err instanceof HostApiError ? err.message : err instanceof SyntaxError ? `JSON 格式不对：${err.message}` : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mcp-form" data-testid="mcp-form">
      <label className="stack-field">
        名字{server ? "" : "（粘贴的 JSON 里带名字时可以留空）"}
        <input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 figma" data-testid="mcp-form-name" />
      </label>
      <label className="stack-field">
        配置（MCP 文档里给的 JSON，和 Claude Code 的 mcpServers 一样）
        <textarea className="field" value={json} onChange={(e) => setJson(e.target.value)} placeholder={EXAMPLE} spellCheck={false} data-testid="mcp-form-json" />
      </label>
      {server && <span className="settings-hint">显示成 {MCP_SECRET_MASK} 的是已保存的密钥，不改就原样保留。</span>}
      <label className="stack-field">
        备注（可以留空）
        <input className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="例如：生图，用公司的账号" />
      </label>
      {error && (
        <span className="form-error" role="alert">
          {error}
        </span>
      )}
      <div className="settings-row end">
        <button type="button" className="btn-ghost small" onClick={onDone} disabled={busy}>
          取消
        </button>
        <button type="button" className="btn-primary small" onClick={() => void save()} disabled={busy || !json.trim()} data-testid="mcp-form-save">
          保存
        </button>
      </div>
    </div>
  );
}
