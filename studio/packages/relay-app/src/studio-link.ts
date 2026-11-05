import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { platformFile, readDevice } from "@amo-studio/account";

// 在 Studio 里打开 (2026-11-05, plans/done/relay-round-2026-11-05.md J1): a session a Studio session on this computer sent
// carries its mark, `studio:<device>:<session>` (Via.conv). When the device is this one's and Studio runs, the button
// asks Studio's Host to show that session (POST /api/ui/open; the workbench acts on it). Studio is found through its
// data dir: AMO_STUDIO_DATA_DIR, the one AMO 平台 set (platform.json), else the one a running Studio wrote down in
// %APPDATA%\AMO Studio\running.json (AMO_STUDIO_HOME; app/src/paths.ts studioRunningFile). Not /api/health: it is
// open and gives numbers only (2026-10-28). host.json and host-token there are this Windows user's; the token never
// leaves this process (the content only asks yes/no and go).

type Env = Record<string, string | undefined>;
type Fetch = typeof fetch;

/** The device and session a Studio mark names; null for any other mark. */
export function parseStudioMark(conv: string): { device: string; sessionId: string } | null {
  const m = /^studio:([A-Za-z0-9_-]{6,64}):([A-Za-z0-9_-]{1,80})$/.exec(conv);
  return m ? { device: m[1]!, sessionId: m[2]! } : null;
}

interface StudioHost {
  url: string;
  token: string;
}

function hostIn(dataDir: string): StudioHost | null {
  try {
    const info = JSON.parse(readFileSync(join(dataDir, "host.json"), "utf8")) as { url?: unknown };
    const token = readFileSync(join(dataDir, "host-token"), "utf8").trim();
    // Only a Host on this computer (AGENTS.md rule 1: the platform reads it the same way).
    if (typeof info.url !== "string" || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(info.url) || !token) return null;
    return { url: info.url.replace(/\/$/, ""), token };
  } catch {
    return null;
  }
}

async function alive(url: string, f: Fetch): Promise<boolean> {
  try {
    const res = await f(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok && ((await res.json()) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

/** The data dir a running Studio wrote down (a Studio from the sources, a portable copy). */
function runningDataDir(env: Env): string | null {
  const home = env.AMO_STUDIO_HOME ? resolve(env.AMO_STUDIO_HOME) : env.APPDATA ? join(env.APPDATA, "AMO Studio") : null;
  if (!home) return null;
  try {
    const dir = (JSON.parse(readFileSync(join(home, "running.json"), "utf8")) as { dataDir?: unknown }).dataDir;
    return typeof dir === "string" && dir ? resolve(dir) : null;
  } catch {
    return null;
  }
}

/** A Studio Host running on this computer, or null. */
export async function findStudio(env: Env = process.env, f: Fetch = fetch): Promise<StudioHost | null> {
  const dirs: string[] = [];
  if (env.AMO_STUDIO_DATA_DIR) dirs.push(resolve(env.AMO_STUDIO_DATA_DIR));
  try {
    const set = (JSON.parse(readFileSync(platformFile(env), "utf8").replace(/^﻿/, "")) as { studioDataDir?: unknown }).studioDataDir;
    if (typeof set === "string" && set.trim()) dirs.push(resolve(set.trim()));
  } catch {
    // no platform
  }
  const running = runningDataDir(env);
  if (running) dirs.push(running);
  for (const dir of new Set(dirs)) {
    const host = hostIn(dir);
    if (host && (await alive(host.url, f))) return host;
  }
  return null;
}

/** The session behind this mark is on this computer and Studio runs. */
export async function studioHas(conv: unknown, env: Env = process.env, f: Fetch = fetch): Promise<boolean> {
  const mark = typeof conv === "string" ? parseStudioMark(conv) : null;
  if (!mark || readDevice({ env })?.id !== mark.device) return false;
  return (await findStudio(env, f)) !== null;
}

/** Asks Studio to show the session; null when it did, else why not, in words. */
export async function openInStudio(conv: unknown, env: Env = process.env, f: Fetch = fetch): Promise<string | null> {
  const mark = typeof conv === "string" ? parseStudioMark(conv) : null;
  if (!mark) return "这个会话不是 AMO Studio 发的";
  if (readDevice({ env })?.id !== mark.device) return "这个会话是另一台电脑上的 Studio 发的";
  const host = await findStudio(env, f);
  if (!host) return "Studio 没开着";
  try {
    const res = await f(`${host.url}/api/ui/open`, {
      method: "POST",
      headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessionId: mark.sessionId }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) return null;
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string; code?: string } } | null;
      // An older Studio has no such route at all.
      return body?.error?.code === "not_found" && body.error.message?.includes("会话") ? "Studio 里没有这个会话了（可能已经删掉）" : "这个版本的 Studio 还不支持从中转跳过去，更新 Studio 后再试";
    }
    return `Studio 没有答应（${res.status}）`;
  } catch {
    return "连不上 Studio";
  }
}
