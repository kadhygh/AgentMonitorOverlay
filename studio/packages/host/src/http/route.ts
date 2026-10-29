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

export interface RouteOptions {
  /** Read the body as raw bytes (ctx.body is a Buffer) up to this many bytes, instead of JSON. */
  rawBody?: number;
  /** Also accept the host token as `?token=` (for <img src>); GET only. */
  queryToken?: boolean;
  /** Answers without the host token (GET only): for what may ask without it, e.g. the AMO platform. Only counts, no content. */
  open?: boolean;
}

/** `path`: the pattern as declared ("/api/tasks/:id"), for checks that go by route (远程 copies, 2026-10-29). */
export type Route = { method: string; path: string; pattern: RegExp; keys: string[]; handle: (ctx: RouteContext) => unknown } & RouteOptions;

export function route(method: string, path: string, handle: (ctx: RouteContext) => unknown, options: RouteOptions = {}): Route {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:([A-Za-z]+)/g, (_, k: string) => (keys.push(k), "([^/]+)"))}$`);
  return { method, path, pattern, keys, handle, ...options };
}

/** A handler's answer that is a file on disk rather than JSON. */
export class FileReply {
  constructor(
    readonly path: string,
    readonly mime: string,
    /**
     * `fresh`: not to be kept by the browser (the same address may stand for a newer file: 远程 step 3). `whole`: read
     * into memory and sent, no file left open (a remote task's copy, deleted when archived).
     */
    readonly options: { fresh?: boolean; whole?: boolean } = {},
  ) {}
}

/** A handler's JSON answer with a status of its own (e.g. 409 with the details a caller needs, not only a message). */
export class JsonReply {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

/** The raw body of a `rawBody` route. */
export const bytes = (v: unknown): Buffer => {
  if (!Buffer.isBuffer(v)) throw new HostError("bad_request", "the body must be the file itself");
  return v;
};

/** A required string field of a request body. */
export const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new HostError("bad_request", `${name} must be a string`);
  return v;
};

/** A request body as an object ({} when it is not one). */
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
