import type { HostRoute, RouteResponse } from "@amo-studio/protocol";
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
  /**
   * 远程 (plans/host-structure.md 8a, 2026-11-05): whether a copy of a task another computer granted this one takes this
   * write to the task or one of its sessions (`/api/tasks/:id…`, `/api/sessions/:id…`; GETs always read the copy).
   * `forward`: the handler sends it on to the computer the task runs on (the remote runtime, TasksFeature); `local`: done
   * on this computer (批注). Left out: refused with a reason (RemoteFeature.guardRoute) — safer than running here.
   */
  remoteCopy?: "forward" | "local";
}

/** `path`: the pattern as declared ("/api/tasks/:id"), for checks that go by route (远程 copies, 2026-10-29). */
export type Route = { method: string; path: string; pattern: RegExp; keys: string[]; handle: (ctx: RouteContext) => unknown } & RouteOptions;

/** The `:name` segments of a path pattern ("/api/sessions/:id/items/:itemId" → "id" | "itemId"). */
type ParamKeys<P extends string> = P extends `${string}:${infer K}/${infer Rest}` ? K | ParamKeys<`/${Rest}`> : P extends `${string}:${infer K}` ? K : never;
type PathOf<K extends string> = K extends `${string} ${infer P}` ? P : never;

/**
 * What a typed route's handler gets (plans/host-structure.md 8b, 2026-11-06): its path params by name. The body stays
 * `unknown` on purpose — it comes from outside, so the handler checks it (obj / str) whatever HostRoutes says it is.
 */
export interface Ctx<K extends HostRoute> {
  method: string;
  path: string;
  params: Record<ParamKeys<PathOf<K>>, string>;
  query: URLSearchParams;
  body: unknown;
}

/**
 * What a typed route's handler may answer: the response HostRoutes declares (a file on disk where it declares a Blob),
 * or a JsonReply with a status of its own.
 */
export type Res<K extends HostRoute> = (RouteResponse<K> extends Blob ? FileReply : RouteResponse<K>) | JsonReply;

/**
 * One route by its HostRoutes key ("GET /api/tasks/:id"): the compiler checks the key is declared in protocol's
 * HostRoutes and the handler answers what is declared there (8b, 2026-11-06: before, nothing stopped the two drifting).
 */
export function route<K extends HostRoute>(key: K, handle: (ctx: Ctx<K>) => Res<K> | Promise<Res<K>>, options?: RouteOptions): Route {
  const space = key.indexOf(" ");
  return untypedRoute(key.slice(0, space), key.slice(space + 1), handle as (ctx: RouteContext) => unknown, options);
}

/** A route that is not in HostRoutes — only for tests that need one (e.g. an undeclared route a remote copy must not reach). */
export function untypedRoute(method: string, path: string, handle: (ctx: RouteContext) => unknown, options: RouteOptions = {}): Route {
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
