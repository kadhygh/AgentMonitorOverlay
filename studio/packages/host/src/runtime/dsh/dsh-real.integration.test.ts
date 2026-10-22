import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DshStatus, ModelProfile, ProfileChoices, Session, SessionItem, StateSnapshot, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir, reserveModelTurn } from "@amo-studio/testkit";
import { startHost, type RunningHost } from "../../host-process.js";
import { FakeServers } from "../codex/fake-servers.test-support.js";
import { BUILTIN_PROFILES } from "../profiles.js";

// The real thing (stage 17): a DSH source clone, real DeepSeek (the deepseek-v4 key from the Credential Manager),
// Studio's Host in between. Runs only with AMO_STUDIO_DSH_CLONE set to the clone (built); each model turn counts
// against budget.json. After pulling a new DSH: `AMO_STUDIO_DSH_CLONE=G:\PROJECT\deepseek-harness npx vitest run
// packages/host/src/runtime/dsh/dsh-real`.

const clone = process.env.AMO_STUDIO_DSH_CLONE;
const PROFILES: ModelProfile[] = BUILTIN_PROFILES.filter((p) => p.runtime === "dsh");
const fetch = (url: string, init: RequestInit = {}) => globalThis.fetch(url, { ...init, headers: { connection: "close", ...(init.headers as Record<string, string> | undefined) } });

describe.skipIf(!clone)("DSH runtime against a real DSH clone and DeepSeek", () => {
  let root: string;
  let host: RunningHost;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${host.info.url}${path}`, { method, headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = (await res.json()) as T;
    if (res.status !== 200) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  const items = (id: string) => call<SessionItem[]>("GET", `/api/sessions/${id}/items`);
  const status = async (id: string) => (await call<StateSnapshot>("GET", "/api/state")).sessions.find((s) => s.id === id)?.status;
  const settled = async (id: string) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 180_000) {
      const s = await status(id);
      if (s === "idle" || s === "error") return s;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error("turn did not end in 3 minutes");
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "amo-studio-test-dshreal-"));
    mkdirSync(join(root, "ws"));
    host = await startHost({ dataDir: join(root, "data"), port: 0, profiles: PROFILES, servers: new FakeServers([]) });
  });
  afterAll(async () => {
    await host?.shutdown();
    removeTempDir(root);
  });

  it("「检查」 starts the clone over ACP and lists its models", async () => {
    await call<DshStatus>("PUT", "/api/dsh", { path: clone });
    const s = await call<DshStatus>("POST", "/api/dsh/check");
    expect(s.check?.ok, s.check?.message).toBe(true);
    const choices = await call<ProfileChoices>("GET", "/api/profiles/dsh-deepseek/choices");
    expect(choices.models.length).toBeGreaterThan(0);
    expect(choices.models.every((m) => !m.id.includes('"'))).toBe(true);
  }, 120_000);

  it("runs a command and reads AMO through the MCP, with its role card", async () => {
    const ws = await call<Workspace>("POST", "/api/workspaces", { path: join(root, "ws") });
    reserveModelTurn("deepseek", "S17 real DSH: command");
    const { session } = await call<{ task: Task; session: Session }>("POST", "/api/tasks", {
      title: "核对 DSH 接入",
      workspaceId: ws.id,
      firstSession: { profileId: "dsh-deepseek", text: 'Run exactly this shell command and tell me its output: node -e "console.log(6*7)"' },
    });
    expect(await settled(session.id)).toBe("idle");
    let list = await items(session.id);
    expect(list.some((i) => i.type === "tool" && i.kind === "command")).toBe(true);
    expect(list.filter((i) => i.type === "agent").map((i) => (i.type === "agent" ? i.markdown : "")).join("\n")).toContain("42");
    expect(list.find((i) => i.type === "turn")).toMatchObject({ state: "completed", usage: { context: expect.any(Number), contextWindow: expect.any(Number) } });
    // Tokens and speed from DSH's own session log (2026-10-22).
    const turn = list.find((i) => i.type === "turn");
    expect(turn?.type === "turn" && turn.usage!.output > 0 && !!turn.decode && turn.decode.tokens > 0 && turn.decode.ms > 0).toBe(true);

    reserveModelTurn("deepseek", "S17 real DSH: AMO MCP");
    await call("POST", `/api/sessions/${session.id}/messages`, { text: "Call the amo_whoami tool. What is the title of your task? Answer with the title only." });
    expect(await settled(session.id)).toBe("idle");
    list = await items(session.id);
    expect(list.some((i) => i.type === "tool" && i.kind === "mcp")).toBe(true);
    expect(list.filter((i) => i.type === "agent").at(-1)).toMatchObject({ markdown: expect.stringContaining("核对 DSH 接入") });
  }, 400_000);

  it("DSH keeps a session's starting permission; switched to 完全访问, Studio grants what it asks (2026-10-22)", async () => {
    await call("PUT", "/api/dsh", { path: clone });
    mkdirSync(join(root, "ws-permission"));
    const ws = await call<Workspace>("POST", "/api/workspaces", { path: join(root, "ws-permission") });
    const outside = join(root, "outside.txt");
    const ask = `Create the file ${outside} containing the word ok, with a shell command. It is outside your workspace: if the sandbox refuses, retry with escalated permissions.`;
    reserveModelTurn("deepseek", "S22 real DSH: escalation asked");
    const { session } = await call<{ task: Task; session: Session }>("POST", "/api/tasks", { title: "权限", workspaceId: ws.id, firstSession: { profileId: "dsh-deepseek", text: ask } });
    // Under workspace-write the write outside asks the person.
    const t0 = Date.now();
    while (Date.now() - t0 < 180_000 && (await status(session.id)) !== "awaiting-approval") await new Promise((r) => setTimeout(r, 300));
    expect(await status(session.id)).toBe("awaiting-approval");
    // 完全访问 now: the waiting request is granted without an answer, and the turn goes on.
    await call("PATCH", `/api/sessions/${session.id}/options`, { permission: "full-access" });
    expect(await settled(session.id)).toBe("idle");
    expect((await items(session.id)).filter((i) => i.type === "approval").every((i) => i.type === "approval" && i.state === "accepted")).toBe(true);
    // Later turns (the process restarted, DSH still holding workspace-write): what it asks is granted too.
    reserveModelTurn("deepseek", "S22 real DSH: escalation granted");
    await call("POST", `/api/sessions/${session.id}/messages`, { text: `Now overwrite ${outside} with the word done, the same way.` });
    expect(await settled(session.id)).toBe("idle");
    expect((await items(session.id)).filter((i) => i.type === "approval").every((i) => i.type === "approval" && i.state === "accepted")).toBe(true);
  }, 400_000);
});
