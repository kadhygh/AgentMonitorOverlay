import { HostError } from "../core/shared.js";

// One REST route: method, path pattern ("/api/tasks/:id"), handler. Features declare theirs (features/<name>/routes.ts)
// and the server gathers them (features/index.ts).

export interface RouteContext {
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
}

export type Route = { method: string; pattern: RegExp; keys: string[]; handle: (ctx: RouteContext) => unknown };

export function route(method: string, path: string, handle: (ctx: RouteContext) => unknown): Route {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:([A-Za-z]+)/g, (_, k: string) => (keys.push(k), "([^/]+)"))}$`);
  return { method, pattern, keys, handle };
}

/** A required string field of a request body. */
export const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new HostError("bad_request", `${name} must be a string`);
  return v;
};

/** A request body as an object ({} when it is not one). */
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
