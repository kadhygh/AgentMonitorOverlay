import { useEffect, useState } from "react";
import type { CanvasOutline } from "@amo-studio/protocol";
import { call, copyText, type HostLink } from "../host/client.js";
import { onHostEvent } from "../host/events.js";

/**
 * "agent 视角": the canvas as an agent reads it (`canvas.read`): structure without coordinates, as an outline or JSON.
 * Refreshes when the canvas, tasks or sessions change.
 */
export function AgentTab({ link }: { link: HostLink }) {
  const [data, setData] = useState<{ outline: string; json: CanvasOutline } | null>(null);
  const [mode, setMode] = useState<"outline" | "json">("outline");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () => call(link, "GET /api/canvas/outline").then((d) => !cancelled && setData(d));
    const off = onHostEvent((e) => {
      if (e.type !== "canvas.updated" && e.type !== "task.upserted" && e.type !== "session.upserted" && e.type !== "workspace.upserted") return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 150); // coalesce bursts (e.g. a turn updating several sessions)
    });
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [link]);

  const text = data ? (mode === "outline" ? data.outline : JSON.stringify(data.json, null, 2)) : "";

  return (
    <div className="side-section" role="group" aria-label="agent 视角">
      <span className="side-note">agent 通过 MCP 读取画布时看到的就是这些：只有结构，没有坐标。</span>
      <div className="agent-tools">
        <div className="side-tabs small">
          <button type="button" className="side-tab" aria-pressed={mode === "outline"} onClick={() => setMode("outline")}>
            大纲
          </button>
          <button type="button" className="side-tab" aria-pressed={mode === "json"} onClick={() => setMode("json")}>
            JSON
          </button>
        </div>
        <button
          type="button"
          className="btn-ghost small"
          disabled={!data}
          onClick={() =>
            void copyText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre className="agent-view" data-testid="agent-view">
        {data ? text : "加载中…"}
      </pre>
    </div>
  );
}
