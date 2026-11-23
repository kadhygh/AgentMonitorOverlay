// What the client is asked to open when it starts, or when a second start hands it on (single instance): from AMO Studio
// and anything else that starts it with an argument.
//
// - `--open=cowork:<id>`: a 协作 (2026-11-23, the user: Studio 打开中转客户端里的某个协作); `--open=thread:<id>` a 子会话, a
//   中转会话 or a chat. Also as two arguments (`--open cowork:<id>`).
// - `--open-thread <id>` (2026-11-05, plans/done/relay-round-2026-11-05.md J2): Studio's 在中转里打开, kept for the
//   Studios that send it; the same as `--open=thread:<id>`.
//
// The content gets it as `<kind>:<id>` (shell-api.ts takeOpen / onOpen). An id is the service's (`t_` and hex): anything
// else is not handed on, so an argument cannot carry markup or a path into the page.

export type OpenKind = "cowork" | "thread";
export interface OpenRef {
  kind: OpenKind;
  id: string;
}

// (not starting with "-": `--open-thread --server …` names no thread)
const ID = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,79}$/;
const KINDS: readonly OpenKind[] = ["cowork", "thread"];

/** `cowork:<id>` / `thread:<id>` → the ref; null for anything else. */
export function parseOpenValue(value: string | undefined): OpenRef | null {
  if (!value) return null;
  const at = value.indexOf(":");
  if (at < 0) return null;
  const kind = value.slice(0, at) as OpenKind;
  const id = value.slice(at + 1);
  return KINDS.includes(kind) && ID.test(id) ? { kind, id } : null;
}

/** What the arguments ask to open (the last such argument wins), or null. */
export function parseOpenArg(argv: readonly string[]): OpenRef | null {
  let found: OpenRef | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    let ref: OpenRef | null | undefined;
    if (a.startsWith("--open=")) ref = parseOpenValue(a.slice("--open=".length));
    else if (a === "--open") ref = parseOpenValue(argv[i + 1]);
    else if (a === "--open-thread") ref = argv[i + 1] && ID.test(argv[i + 1]!) ? { kind: "thread", id: argv[i + 1]! } : null;
    if (ref) found = ref;
  }
  return found;
}

export const openText = (ref: OpenRef) => `${ref.kind}:${ref.id}`;

/**
 * A second start with something to open, when a client runs already: does the running one take it (its running.json
 * says `open` and its pid lives)? Then the second start has handed it on and is done — it neither waits for the lock
 * (each try would hand it on again) nor takes over. A client from before `open` quits when another copy starts
 * (2026-10-29), so then the second start waits for the lock and opens it itself, as before.
 */
export function runningTakesOpen(running: unknown, alive: (pid: number) => boolean): boolean {
  const r = running as { pid?: unknown; open?: unknown } | null;
  return !!r && typeof r.pid === "number" && Array.isArray(r.open) && r.open.includes("cowork") && alive(r.pid);
}
