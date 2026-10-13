import { z } from "zod";
import type { Id } from "@amo-studio/protocol";
import type { HostService } from "../service.js";
import { HostError } from "../core/shared.js";
import { NotFoundError, ReadModel } from "./read-model.js";

// What every AMO MCP tool is built from: the tool shape, the result helpers and the caller's context. The tools live
// with their features (features/<name>/mcp.ts); mcp/tools.ts gathers them.

/** The session a tool call comes from, if Studio could tell. */
export interface McpCaller {
  sessionId: Id;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface AmoTool {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** Reads only Studio's state (annotated readOnlyHint). */
  readOnly: boolean;
  /**
   * Runs without asking the person: reads, and writes that only touch the caller's own task. Codex gets
   * `tools.<name>.approval_mode = "approve"` for these; Claude lists them in allowedTools.
   */
  autoApprove: boolean;
  run(args: Record<string, unknown>): ToolResult;
}

export const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });

/** Runs a read and turns a missing id into a tool error the agent can read, instead of a protocol error. */
export function answer(read: () => unknown): ToolResult {
  try {
    return json(read());
  } catch (err) {
    if (err instanceof NotFoundError || err instanceof HostError) return { content: [{ type: "text", text: err.message }], isError: true };
    throw err;
  }
}

export const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Runs a write for the caller; Studio's own refusals become readable tool errors. */
export function write(caller: McpCaller | null, run: (caller: McpCaller) => unknown): ToolResult {
  if (!caller) return fail("这次调用没有 AMO 会话身份（例如由 Codex 自己派生的子 agent），只能使用只读工具。");
  try {
    return json(run(caller));
  } catch (err) {
    if (err instanceof HostError) return fail(err.message);
    throw err;
  }
}

/** What a feature's tools get: the service, the caller (null: reading only), the read model and the caller's own task and topic. */
export interface ToolContext {
  service: HostService;
  caller: McpCaller | null;
  model: ReadModel;
  /** The caller's own task; refused for a topic session. */
  ownTask(c: McpCaller): Id;
  /** The topic whose canvas the caller may arrange: its own topic, or its task's. */
  ownTopic(c: McpCaller): Id;
  /** Refuses tasks outside the caller's topic. */
  inOwnTopic(c: McpCaller, ...taskIds: unknown[]): void;
}

export function toolContext(service: HostService, caller: McpCaller | null): ToolContext {
  const ownTask = (c: McpCaller): Id => {
    const taskId = service.store.getSession(c.sessionId)!.taskId;
    if (!taskId) throw new HostError("bad_request", "你是专题会话，没有自己的任务：用 mailbox_send 给任务或它们的会话留言。");
    return taskId;
  };
  const ownTopic = (c: McpCaller): Id => {
    const topic = service.topics.topicOfSession(c.sessionId);
    if (!topic) throw new HostError("bad_request", "你的任务不在任何专题里，没有画布可以整理。");
    return topic.id;
  };
  const inOwnTopic = (c: McpCaller, ...taskIds: unknown[]) => {
    const topicId = ownTopic(c);
    for (const id of taskIds) {
      if (service.store.getTask(String(id))?.topicId !== topicId) throw new HostError("bad_request", `任务 ${String(id)} 不在你所在的专题里`);
    }
  };
  return { service, caller, model: new ReadModel(service, caller), ownTask, ownTopic, inOwnTopic };
}
