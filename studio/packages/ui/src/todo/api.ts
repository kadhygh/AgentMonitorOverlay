import type { TodoOp, TodoView } from "@amo-studio/protocol";
import { HostApiError, type HostLink } from "../host/client.js";

// 待办's routes on the 便签 program's own server (packages/notes/src/server.ts, 2026-11-01).

async function todoCall<T>(link: HostLink, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${link.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json()) as T & { error?: { code: string; message: string } };
  if (!res.ok) throw new HostApiError(res.status, data.error?.code ?? "internal", data.error?.message ?? res.statusText);
  return data;
}

export const todoView = (link: HostLink) => todoCall<TodoView>(link, "GET", "/api/todo");
export const todoChange = (link: HostLink, ops: TodoOp[]) => todoCall<TodoView>(link, "POST", "/api/todo/ops", { ops });
export const todoSyncNow = (link: HostLink) => todoCall<TodoView>(link, "POST", "/api/todo/sync");
/** 在 AMO 平台里登录: false when the platform is not installed here. */
export const openPlatform = (link: HostLink) => todoCall<{ opened: boolean }>(link, "POST", "/api/notes/open-platform").then((r) => r.opened);
export const openTodoWindow = (link: HostLink) => todoCall<object>(link, "POST", "/api/notes/todo-window");
