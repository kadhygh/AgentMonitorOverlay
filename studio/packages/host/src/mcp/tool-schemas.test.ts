import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ModelProfile } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { FEATURES } from "../features/index.js";
import { CodexRuntime } from "../runtime/codex/codex-runtime.js";
import { FakeServers } from "../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../service.js";
import { Store } from "../store/store.js";
import { toolContext, type AmoTool } from "./tool-kit.js";

// Every AMO tool's JSON Schema, as the MCP SDK lists it, stays within what every client takes (2026-11-25): Gemini on agy
// left out cowork_post (`const` from z.literal(true)), cowork_matter (`"null"` types from .nullable()) and session_start
// (additionalProperties {type: boolean} from z.record(…, z.boolean())) — the other 66 tools it had.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];
let root: string;
let store: Store;
let tools: AmoTool[];
let listed: Array<{ name: string; inputSchema: unknown }>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-tool-schemas-"));
  store = new Store(join(root, "studio.db"));
  const service = new HostService(store, new CodexRuntime({ store, servers: new FakeServers(PROFILES), profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  // All of them: every feature (also those off by default) and the scheduler's own schedule_propose.
  vi.spyOn(service.planning, "isSchedulerSession").mockReturnValue(true);
  const ctx = toolContext(service, { sessionId: "s-any" });
  tools = FEATURES.flatMap((f) => f.tools?.(ctx) ?? []);
  const server = new McpServer({ name: "amo", version: "0" });
  for (const t of tools) server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.inputSchema }, (args: Record<string, unknown>) => t.run(args));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "amo-test", version: "0" });
  await client.connect(b);
  listed = (await client.listTools()).tools;
  await client.close();
  await server.close();
});

afterAll(() => {
  store.close();
  removeTempDir(root);
});

/** Where a schema uses what agy refuses: `const`, a `"null"` type, an additionalProperties other than {} or true. */
function refused(schema: unknown, path = ""): string[] {
  if (Array.isArray(schema)) return schema.flatMap((s, i) => refused(s, `${path}[${i}]`));
  if (!schema || typeof schema !== "object") return [];
  const s = schema as Record<string, unknown>;
  const out: string[] = [];
  if ("const" in s) out.push(`${path}: const`);
  if (s.type === "null" || (Array.isArray(s.type) && s.type.includes("null"))) out.push(`${path}: type null`);
  if ("additionalProperties" in s) {
    const ap = s.additionalProperties;
    if (!(ap === true || (ap && typeof ap === "object" && !Array.isArray(ap) && Object.keys(ap).length === 0))) out.push(`${path}: additionalProperties ${JSON.stringify(ap)}`);
  }
  for (const [k, v] of Object.entries(s)) out.push(...refused(v, `${path}.${k}`));
  return out;
}

describe("AMO tools' JSON Schemas", () => {
  it("lists every tool, none with const, a null type or a typed additionalProperties", () => {
    expect(listed.length).toBe(tools.length);
    expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining(["cowork_post", "cowork_matter", "session_start", "schedule_propose"]));
    const bad = listed.flatMap((t) => refused(t.inputSchema).map((p) => `${t.name}${p}`));
    expect(bad).toEqual([]);
  });

  it("the check finds each of the three forms", () => {
    expect(refused({ properties: { h: { anyOf: [{ const: true, type: "boolean" }] } } })).toEqual([".properties.h.anyOf[0]: const"]);
    expect(refused({ properties: { b: { type: ["string", "null"] }, g: { anyOf: [{ type: "null" }] } } })).toEqual([".properties.b: type null", ".properties.g.anyOf[0]: type null"]);
    expect(refused({ properties: { m: { additionalProperties: { type: "boolean" } } } })).toEqual([".properties.m: additionalProperties {\"type\":\"boolean\"}"]);
    expect(refused({ additionalProperties: false, properties: { m: { additionalProperties: {} } } })).toEqual([": additionalProperties false"]);
  });

  it("cowork_matter still takes null for blocker and gate, as an empty string (which clears them)", () => {
    const shape = tools.find((t) => t.name === "cowork_matter")!.inputSchema;
    expect(z.object(shape).parse({ action: "update", matter: "事项 1", blocker: null, gate: null })).toMatchObject({ blocker: "", gate: "" });
    expect(z.object(shape).parse({ action: "update", matter: "事项 1", blocker: "卡在 事项 2", gate: "master" })).toMatchObject({ blocker: "卡在 事项 2", gate: "master" });
    expect(z.object(shape).parse({ action: "update", matter: "事项 1" })).not.toHaveProperty("blocker");
    expect(z.object(shape).safeParse({ action: "update", gate: "nope" }).success).toBe(false);
  });

  it("cowork_post takes handled true and a list of seqs; session_start's mcp takes a map", () => {
    const post = z.object(tools.find((t) => t.name === "cowork_post")!.inputSchema);
    expect(post.parse({ body: "x", handled: true }).handled).toBe(true);
    expect(post.parse({ body: "x", handled: [7, "#9"] }).handled).toEqual([7, "#9"]);
    const start = z.object(tools.find((t) => t.name === "session_start")!.inputSchema);
    expect(start.parse({ text: "x", mcp: { playwright: true } }).mcp).toEqual({ playwright: true });
  });
});
