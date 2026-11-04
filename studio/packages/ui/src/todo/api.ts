import type { TodoOp, TodoView } from "@amo-studio/protocol";
import { request, type HostLink } from "../host/client.js";

// 待办's routes on the 便签 program's own server (packages/notes/src/server.ts, 2026-11-01).

const todoCall = <T>(link: HostLink, method: "GET" | "POST", path: string, body?: unknown): Promise<T> => request<T>(link, method, path, body);

export const todoView = (link: HostLink) => todoCall<TodoView>(link, "GET", "/api/todo");
export const todoChange = (link: HostLink, ops: TodoOp[]) => todoCall<TodoView>(link, "POST", "/api/todo/ops", { ops });
/** 问题 #10: the tag of an item bound to a Studio task — Studio opens it (409 when Studio is not there). */
export const todoOpenBound = (link: HostLink, id: string) => todoCall<object>(link, "POST", "/api/todo/open", { id });
export const todoUnbind = (link: HostLink, id: string) => todoCall<TodoView>(link, "POST", "/api/todo/link", { id, link: null });
export const todoSyncNow =(link: HostLink) => todoCall<TodoView>(link, "POST", "/api/todo/sync");
/** 在 AMO 平台里登录: false when the platform is not installed here. */
export const openPlatform = (link: HostLink) => todoCall<{ opened: boolean }>(link, "POST", "/api/notes/open-platform").then((r) => r.opened);
export const openTodoWindow = (link: HostLink) => todoCall<object>(link, "POST", "/api/notes/todo-window");
