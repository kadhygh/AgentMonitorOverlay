import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { startFakeAppServer, type FakeAppServer } from "@amo-studio/testkit";
import { CodexRpcClient, ConnectionClosedError, RpcError, type ServerNotification, type ServerRequest } from "./rpc-client.js";
import { createServer } from "node:http";
import { listenInStudioRange } from "@amo-studio/testkit";

let server: FakeAppServer | undefined;
const clients: CodexRpcClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await server?.close();
  server = undefined;
});

async function connect(token = server!.token) {
  const c = await CodexRpcClient.connect({ url: server!.url, token });
  clients.push(c);
  return c;
}

function collect(client: CodexRpcClient) {
  const notes: ServerNotification[] = [];
  const reqs: ServerRequest[] = [];
  client.on("notification", (n) => notes.push(n));
  client.on("request", (r) => reqs.push(r));
  return { notes, reqs };
}

const until = async (pred: () => boolean, timeoutMs = 3000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("CodexRpcClient", () => {
  it("initializes and runs a turn, emitting notifications", async () => {
    server = await startFakeAppServer({ defaultProvider: "amo-mock" });
    const client = await connect();
    const { notes } = collect(client);
    expect(server.calls.map((c) => c.method)).toEqual(["initialize"]);

    const started = await client.request("thread/start", { cwd: "C:/sandbox" } as never);
    expect(started.modelProvider).toBe("amo-mock");
    const { turn } = await client.request("turn/start", { threadId: started.thread.id, input: [{ type: "text", text: "hi", text_elements: [] }] } as never);
    await until(() => notes.some((n) => n.method === "turn/completed" && n.params.turn.id === turn.id));
    const completed = notes.filter((n) => n.method === "item/completed").map((n) => (n.params as { item: { type: string } }).item.type);
    expect(completed).toEqual(["userMessage", "agentMessage"]);
  });

  it("surfaces JSON-RPC errors as RpcError", async () => {
    server = await startFakeAppServer();
    const client = await connect();
    const err = await client.request("thread/read", { threadId: "missing" } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).code).toBe(-32600);
    expect((err as RpcError).message).toMatch(/thread\/read: thread not found/);
  });

  it("refuses a bad token", async () => {
    server = await startFakeAppServer();
    await expect(CodexRpcClient.connect({ url: server.url, token: "wrong" })).rejects.toThrow(/refused|401/);
  });

  it("delivers server requests and sends answers back", async () => {
    server = await startFakeAppServer();
    const client = await connect();
    const { notes, reqs } = collect(client);
    const { thread } = await client.request("thread/start", {} as never);
    const { turn } = await client.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "[[shell: cmd /c echo x]]", text_elements: [] }] } as never);
    await until(() => reqs.length > 0);
    expect(reqs[0]!.method).toBe("item/commandExecution/requestApproval");
    client.respond(reqs[0]!.id, { decision: "accept" });
    await until(() => notes.some((n) => n.method === "turn/completed" && n.params.turn.id === turn.id));
    expect(notes.some((n) => n.method === "serverRequest/resolved")).toBe(true);
  });

  it("rejects pending and new requests once the connection closes", async () => {
    server = await startFakeAppServer();
    const client = await connect();
    let closed = false;
    client.on("close", () => (closed = true));
    await server.close();
    server = undefined;
    await until(() => closed);
    expect(client.isOpen).toBe(false);
    await expect(client.request("thread/list", {} as never)).rejects.toBeInstanceOf(ConnectionClosedError);
  });

  it("answers unknown methods with -32601 and times out requests that never get an answer", async () => {
    server = await startFakeAppServer();
    const client = await connect();
    await expect(client.request("hooks/list", {} as never)).rejects.toMatchObject({ code: -32601 });

    // A server that answers initialize and nothing else.
    const http = createServer();
    await listenInStudioRange(http); // before attaching ws, which re-emits the server's (retried) listen errors
    const silent = new WebSocketServer({ server: http });
    silent.on("connection", (ws) => ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === "initialize") ws.send(JSON.stringify({ id: msg.id, result: {} }));
    }));
    try {
      const mute = await CodexRpcClient.connect({ url: `ws://127.0.0.1:${(http.address() as AddressInfo).port}`, token: "t" });
      clients.push(mute);
      await expect(mute.request("thread/list", {} as never, { timeoutMs: 50 })).rejects.toThrow(/timed out after 50 ms/);
    } finally {
      for (const c of silent.clients) c.terminate();
      await new Promise<void>((r) => silent.close(() => http.close(() => r())));
    }
  });
});
