import { useEffect, useState } from "react";
import { MCP_SOURCE_LABELS, type McpEntry, type McpServerStatusSeen, type McpServerSpec } from "@amo-studio/protocol";
import { onHostEvent } from "../host/events.js";
import "./mcp.css";

// MCP 设置 (2026-11-04, plans/done/mcp.md): what 设置 → MCP, 编辑项目 and the composer's MCP tray share.

/** Opens 设置 on its MCP page from anywhere in the main window (App listens). */
export const OPEN_SETTINGS_EVENT = "amo:open-settings";
export function openMcpSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: "mcp" }));
}

/** Calls `reload` again whenever the Host says something about MCP changed. */
export function useMcpChanges(reload: () => void): void {
  useEffect(() => onHostEvent((e) => e.type === "mcp.changed" && reload()), [reload]);
}

const STATUS: Record<string, { mark: string; text: string }> = {
  connected: { mark: "✓", text: "已连接" },
  failed: { mark: "!", text: "连不上" },
  "needs-auth": { mark: "!", text: "需要授权" },
  pending: { mark: "◐", text: "正在连接" },
  disabled: { mark: "○", text: "已停用" },
};

/** A server's last known status, as a mark and words (never only a colour). */
export function McpStatus({ status }: { status?: McpServerStatusSeen | undefined }) {
  if (!status) return null;
  const s = STATUS[status.status] ?? { mark: "○", text: status.status };
  const hint =
    status.status === "needs-auth"
      ? "要先登录授权一次：在终端里运行 claude，输入 /mcp，选中它按提示在浏览器里授权；之后新开的会话就能用"
      : status.status === "failed"
        ? (status.error ?? "检查命令或地址")
        : `最近一次：${new Date(status.at).toLocaleString()}`;
  return (
    <span className={`mcp-status mcp-status-${status.status}`} title={hint} data-testid="mcp-status">
      {s.mark} {s.text}
    </span>
  );
}

export function sourceLabel(e: McpEntry): string {
  return MCP_SOURCE_LABELS[e.source];
}

/**
 * A level's choice for one server: follow the level above (showing what that gives), on, or off. `aboveLabel` names
 * the level followed ("默认", "全局").
 */
export function ChoiceChips({ entry, aboveLabel, disabled, onChange }: { entry: McpEntry; aboveLabel: string; disabled?: boolean; onChange(choice: boolean | null): void }) {
  const current = entry.choice === undefined ? "follow" : entry.choice ? "on" : "off";
  const options: Array<[typeof current, string, boolean | null]> = [
    ["follow", `${aboveLabel}（${entry.inherited ? "开" : "关"}）`, null],
    ["on", "开", true],
    ["off", "关", false],
  ];
  return (
    <span className="chips mcp-choice" role="radiogroup" aria-label={`${entry.name} 开不开`}>
      {options.map(([id, label, value]) => (
        <button key={id} type="button" role="radio" className="chip small" aria-checked={current === id} aria-pressed={current === id} disabled={disabled} onClick={() => current !== id && onChange(value)} data-testid={`mcp-choice-${entry.name}-${id}`}>
          {label}
        </button>
      ))}
    </span>
  );
}

/** One server's line: name, where it is from, what it runs, its note and status; `children` is the control. */
export function EntryLine({ entry, children }: { entry: McpEntry; children?: React.ReactNode }) {
  return (
    <div className="mcp-entry" data-testid={`mcp-entry-${entry.name}`} data-on={entry.on || undefined}>
      <div className="mcp-entry-main">
        <span className="mcp-name">{entry.name}</span>
        <span className="mcp-source">{sourceLabel(entry)}</span>
        <McpStatus status={entry.status} />
        {entry.summary && (
          <code className="mcp-summary" title={entry.summary}>
            {entry.summary}
          </code>
        )}
        {entry.note && <span className="settings-hint mcp-note">{entry.note}</span>}
      </div>
      {children}
    </div>
  );
}

/**
 * What the person pastes: one `mcpServers` entry ({"command": …} / {"type": "http", "url": …}), `{"name": entry}`, or a
 * whole `{"mcpServers": {…}}` as MCP servers' docs give it. Returns the servers found, by name ("" when unnamed).
 */
export function parsePasted(text: string): Array<{ name: string; spec: McpServerSpec }> {
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("要粘贴一个 JSON 对象");
  const o = value as Record<string, unknown>;
  const isSpec = (v: unknown) => !!v && typeof v === "object" && ("command" in (v as object) || "url" in (v as object));
  if (isSpec(o)) return [{ name: "", spec: o as unknown as McpServerSpec }];
  const map = (o.mcpServers && typeof o.mcpServers === "object" ? o.mcpServers : o) as Record<string, unknown>;
  const found = Object.entries(map).filter(([, v]) => isSpec(v));
  if (!found.length) throw new Error("没认出 MCP 配置：本地程序要有 command，远程的要有 url");
  return found.map(([name, spec]) => ({ name, spec: spec as McpServerSpec }));
}
