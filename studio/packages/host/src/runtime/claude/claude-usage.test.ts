import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchClaudeUsage, type ClaudeUsageExtra } from "./claude-usage.js";

// The shape /api/oauth/usage answered on 2026-11-12 (trimmed): Fable's weekly limit only in `limits[]`.
const BODY = {
  five_hour: { utilization: 6, resets_at: "2026-11-12T16:50:00.207589+00:00" },
  seven_day: { utilization: 39, resets_at: "2026-11-17T17:00:00.207611+00:00" },
  seven_day_opus: null,
  seven_day_sonnet: null,
  limits: [
    { kind: "session", percent: 6, resets_at: "2026-11-12T16:50:00.207589+00:00", scope: null },
    { kind: "weekly_all", percent: 39, resets_at: "2026-11-17T17:00:00.207611+00:00", scope: null },
    { kind: "weekly_scoped", percent: 48, resets_at: "2026-11-17T17:00:00.207781+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null } },
  ],
  seven_day_breakdown: { rows: [{ key: "claude_code", display_name: "Claude Code", percent: 100 }, { key: "chat", display_name: "Chats", percent: 0 }] },
};

let close: (() => void) | null = null;
afterEach(() => close?.());

async function serve(body: unknown): Promise<string> {
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body)));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("fetchClaudeUsage", () => {
  it("reads 5 小时, 每周 and a model's weekly limit given only in limits[] (Fable), and where the week went", async () => {
    const extra: ClaudeUsageExtra = { breakdown: null };
    const windows = await fetchClaudeUsage(await serve(BODY), "t", 5_000, extra);
    expect(windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ["5 小时", 6],
      ["每周", 39],
      ["Fable 每周", 48],
    ]);
    expect(windows[2]!.resetsAt).toBe("2026-11-17T17:00:00.207Z");
    expect(windows.map((w) => w.model ?? null)).toEqual([null, null, "Fable"]);
    expect(extra.breakdown).toBe("Claude Code 100% · Chats 0%");
  });

  it("does not show a model's window twice when the old key has it too", async () => {
    const windows = await fetchClaudeUsage(await serve({ ...BODY, seven_day_opus: { utilization: 10, resets_at: null }, limits: [{ kind: "weekly_scoped", percent: 11, scope: { model: { display_name: "Opus" } } }] }), "t");
    expect(windows.filter((w) => w.label === "Opus 每周").map((w) => w.usedPercent)).toEqual([10]);
  });
});
