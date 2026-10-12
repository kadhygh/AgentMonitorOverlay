import { afterEach, describe, expect, it } from "vitest";
import { startFakeAppServer, type FakeAppServer } from "./fake-app-server.js";

// Minimal JSON-RPC client for exercising the fake; the Host has its own client.
class TestClient {
  ws!: WebSocket;
  events: Array<{ id?: number; method: string; params: any }> = [];
  private nextId = 1;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private waiters: Array<{ pred: (e: any) => boolean; res: (e: any) => void }> = [];
  autoDecision: string | null = null;

  constructor(private readonly server: FakeAppServer, private readonly token = server.token) {}

  async connect() {
    // Under a full parallel run the handshake occasionally failed on Windows with a bare "ws error"; retry a couple of
    // times and keep the underlying error if it still fails.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.open();
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await new Promise((r) => setTimeout(r, 100 * attempt));
      }
    }
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== undefined && !msg.method) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
        return;
      }
      this.events.push(msg);
      this.waiters = this.waiters.filter((w) => !(w.pred(msg) && (w.res(msg), true)));
      if (msg.id !== undefined && this.autoDecision) this.respond(msg.id, this.autoDecision);
    };
    await this.request("initialize", { clientInfo: { name: "test", version: "0" } });
  }
  private open(): Promise<void> {
    // Node's WebSocket (undici) accepts headers as a non-standard option.
    this.ws = new WebSocket(this.server.url, { headers: { Authorization: `Bearer ${this.token}` } } as unknown as string[]);
    return new Promise<void>((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = (ev) => {
        const cause = (ev as unknown as { error?: unknown }).error;
        rej(new Error(`ws error${cause instanceof Error ? `: ${cause.message}` : ""}`));
      };
    });
  }
  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  respond(id: number, decision: string) {
    this.ws.send(JSON.stringify({ id, result: { decision } }));
  }
  waitFor(pred: (e: any) => boolean, timeoutMs = 5000): Promise<any> {
    const hit = this.events.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timeout")), timeoutMs);
      this.waiters.push({ pred, res: (e) => (clearTimeout(t), res(e)) });
    });
  }
  close() {
    this.ws.close();
  }
}

const turnDone = (turnId: string) => (e: any) => e.method === "turn/completed" && e.params.turn.id === turnId;
const isApproval = (e: any) => e.method === "item/commandExecution/requestApproval";
const text = (t: string) => [{ type: "text", text: t }];

let server: FakeAppServer;
const clients: TestClient[] = [];
async function client() {
  const c = new TestClient(server);
  await c.connect();
  clients.push(c);
  return c;
}
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
});

async function seededThread(a: TestClient, params: Record<string, unknown> = {}) {
  const { thread } = await a.request("thread/start", { cwd: "C:/sandbox", ...params });
  const { turn } = await a.request("turn/start", { threadId: thread.id, input: text("seed") });
  await a.waitFor(turnDone(turn.id));
  return thread.id as string;
}

describe("fake app-server", () => {
  it("rejects a wrong token", async () => {
    server = await startFakeAppServer();
    await expect(new TestClient(server, "wrong").connect()).rejects.toThrow();
  });

  it("streams a scripted turn to the subscriber", async () => {
    server = await startFakeAppServer({ defaultProvider: "amo-mock" });
    const a = await client();
    const { thread, modelProvider } = await a.request("thread/start", { cwd: "C:/sandbox" });
    expect(modelProvider).toBe("amo-mock");
    const { turn } = await a.request("turn/start", { threadId: thread.id, input: text("hello") });
    const done = await a.waitFor(turnDone(turn.id));
    expect(done.params.turn.status).toBe("completed");
    const deltas = a.events.filter((e) => e.method === "item/agentMessage/delta").map((e) => e.params.delta).join("");
    expect(deltas).toBe("FAKE: hello");
    const types = a.events.filter((e) => e.method === "item/completed").map((e) => e.params.item.type);
    expect(types).toEqual(["userMessage", "agentMessage"]);
  });

  it("refuses to resume a thread before its first turn", async () => {
    server = await startFakeAppServer();
    const a = await client();
    const b = await client();
    const { thread } = await a.request("thread/start", {});
    await expect(b.request("thread/resume", { threadId: thread.id })).rejects.toThrow(/no rollout/);
  });

  it("broadcasts approvals, takes the first answer and resolves everywhere", async () => {
    server = await startFakeAppServer();
    const a = await client();
    const b = await client();
    const threadId = await seededThread(a);
    await b.request("thread/resume", { threadId });
    const { turn } = await a.request("turn/start", { threadId, input: text("[[shell: cmd /c echo hi]]") });
    const [reqA, reqB] = await Promise.all([a.waitFor(isApproval), b.waitFor(isApproval)]);
    expect(reqA.id).toBe(reqB.id);
    b.respond(reqB.id, "decline");
    a.respond(reqA.id, "accept"); // late answer is ignored
    await a.waitFor(turnDone(turn.id));
    // Each socket delivers independently, so wait on both rather than checking B after A's turn ends.
    await Promise.all([a, b].map((c) => c.waitFor((e) => e.method === "serverRequest/resolved" && e.params.requestId === reqA.id)));
    const cmd = a.events.find((e) => e.method === "item/completed" && e.params.item.type === "commandExecution");
    expect(cmd!.params.item.status).toBe("declined");
  });

  it("replays a pending approval to a late subscriber", async () => {
    server = await startFakeAppServer();
    const a = await client();
    const threadId = await seededThread(a);
    const { turn } = await a.request("turn/start", { threadId, input: text("[[shell: cmd /c echo hi]]") });
    const req = await a.waitFor(isApproval);
    const late = await client();
    await late.request("thread/resume", { threadId });
    const replayed = await late.waitFor(isApproval);
    expect(replayed.id).toBe(req.id);
    late.respond(replayed.id, "accept");
    await a.waitFor(turnDone(turn.id));
    const reply = a.events.filter((e) => e.method === "item/completed" && e.params.item.type === "agentMessage").at(-1);
    expect(reply!.params.item.text).toBe("FAKE-RAN");
  });

  it("announces forks to parent subscribers and defaults their provider to the server's", async () => {
    server = await startFakeAppServer({ defaultProvider: "server-default" });
    const a = await client();
    const b = await client();
    const threadId = await seededThread(a, { modelProvider: "amo-ds" });
    await b.request("thread/resume", { threadId });
    const implicit = await a.request("thread/fork", { threadId });
    const explicit = await a.request("thread/fork", { threadId, modelProvider: "amo-ds" });
    expect(implicit.thread.forkedFromId).toBe(threadId);
    expect(implicit.modelProvider).toBe("server-default");
    expect(explicit.modelProvider).toBe("amo-ds");
    const started = await b.waitFor((e) => e.method === "thread/started" && e.params.thread.id === implicit.thread.id);
    expect(started.params.thread.forkedFromId).toBe(threadId);
    const list = await b.request("thread/list", { modelProviders: ["amo-ds", "server-default"] });
    expect(list.data.map((t: any) => t.id).sort()).toEqual([threadId, implicit.thread.id, explicit.thread.id].sort());
  });

  it("reports subagents with their own thread and events", async () => {
    server = await startFakeAppServer();
    const a = await client();
    const threadId = await seededThread(a);
    const { turn } = await a.request("turn/start", { threadId, input: text("[[subagent]]") });
    await a.waitFor(turnDone(turn.id));
    const activity = a.events.filter((e) => e.method === "item/completed" && e.params.item.type === "subAgentActivity").map((e) => e.params.item);
    expect(activity.map((i) => i.kind)).toEqual(["started", "completed"]);
    const childId = activity[0].agentThreadId;
    expect(a.events.some((e) => e.method === "thread/started" && e.params.thread.id === childId)).toBe(false);
    expect(server.threads.get(childId)!.parentThreadId).toBe(threadId);
    expect(a.events.some((e) => e.method === "item/completed" && e.params.threadId === childId && e.params.item.text === "FAKE-SUB-DONE")).toBe(true);
  });

  it("steers the running turn and rejects a stale expectedTurnId", async () => {
    server = await startFakeAppServer();
    const a = await client();
    const threadId = await seededThread(a);
    const { turn } = await a.request("turn/start", { threadId, input: text("[[slow]]") });
    await expect(a.request("turn/steer", { threadId, expectedTurnId: "stale", input: text("x") })).rejects.toThrow(/expectedTurnId/);
    expect(await a.request("turn/steer", { threadId, expectedTurnId: turn.id, input: text("also this") })).toEqual({ turnId: turn.id });
    await a.waitFor(turnDone(turn.id));
    const last = a.events.filter((e) => e.method === "item/completed" && e.params.item.type === "agentMessage").at(-1);
    expect(last!.params.item.text).toBe("FAKE-STEERED: also this");
  });

  it("interrupts a running turn", async () => {
    server = await startFakeAppServer();
    const a = await client();
    const threadId = await seededThread(a);
    const { turn } = await a.request("turn/start", { threadId, input: text("[[slow]]") });
    await a.waitFor((e) => e.method === "item/agentMessage/delta" && e.params.turnId === turn.id);
    await a.request("turn/interrupt", { threadId, turnId: turn.id });
    const done = await a.waitFor(turnDone(turn.id));
    expect(done.params.turn.status).toBe("interrupted");
    expect(server.threads.get(threadId)!.activeTurn).toBeNull();
  });

  it("marks a scripted failure as a failed turn", async () => {
    server = await startFakeAppServer();
    const a = await client();
    const threadId = await seededThread(a);
    const { turn } = await a.request("turn/start", { threadId, input: text("[[fail]]") });
    expect((await a.waitFor(turnDone(turn.id))).params.turn.status).toBe("failed");
  });
});
