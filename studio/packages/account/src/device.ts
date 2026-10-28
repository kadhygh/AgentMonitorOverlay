import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { readJsonFile, updateJsonFile } from "./json.js";
import { amoFile, type Env } from "./paths.js";

// This computer, as the AMO tools tell the team server about it (plans/remote-session.md, step 1, 2026-10-29): a random
// id that stays with the machine and a name people recognise it by (the computer name until they change it). Pairing
// for remote sessions is by account + device id, since one person's two computers may well be logged in with two
// accounts. Kept in %APPDATA%\AMO\device.json (follows AMO_HOME); the platform or Studio, whichever needs it first,
// makes it, and both read the same file.
//
// device.json: { "id": "d_<24 hex>", "name": "KANGAROO-PC" }

export interface Device {
  /** `d_` + 24 hex digits; never changes once made. */
  id: string;
  /** What people see, e.g. 「台式机」; the computer name by default. */
  name: string;
}

export const DEVICE_NAME_MAX = 40;
/** What the team server accepts as a device id (it checks again). */
export const DEVICE_ID = /^[A-Za-z0-9_-]{6,64}$/;

export const deviceFile = (env: Env = process.env) => amoFile("device.json", env);

/** Why this name will not do, or null: 1–40 characters, no line breaks or other control characters. */
export function deviceNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return "设备名不能为空";
  if (n.length > DEVICE_NAME_MAX) return `设备名太长（最多 ${DEVICE_NAME_MAX} 字）`;
  if (/[\u0000-\u001f\u007f]/.test(n)) return "设备名里不能有控制字符";
  return null;
}

/** The computer's name (COMPUTERNAME on Windows), cut to what a device name may be. */
export function defaultDeviceName(env: Env = process.env): string {
  const n = (env.COMPUTERNAME || hostname() || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, DEVICE_NAME_MAX);
  return n || "这台电脑";
}

/** This computer's device, or null when no tool has made one yet (or the file is not one). Never writes. */
export function readDevice(options: { env?: Env } = {}): Device | null {
  const d = readJsonFile<{ id?: unknown; name?: unknown }>(deviceFile(options.env));
  if (!d || typeof d.id !== "string" || !DEVICE_ID.test(d.id)) return null;
  const name = typeof d.name === "string" && !deviceNameProblem(d.name) ? d.name.trim() : defaultDeviceName(options.env);
  return { id: d.id, name };
}

/**
 * This computer's device, made now when there is none. The first program to make it wins: the file is created only
 * when it is not there (another one starting at the same moment reads the winner's).
 */
export function ensureDevice(options: { env?: Env } = {}): Device {
  const have = readDevice(options);
  if (have) return have;
  const file = deviceFile(options.env);
  const device: Device = { id: `d_${randomBytes(12).toString("hex")}`, name: defaultDeviceName(options.env) };
  mkdirSync(dirname(file), { recursive: true });
  try {
    const fd = openSync(file, "wx");
    try {
      writeSync(fd, JSON.stringify(device, null, 2) + "\n");
    } finally {
      closeSync(fd);
    }
    return device;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // There is a file: someone else's just now, or one that is not a device (damaged) — then it is replaced.
  const now = readDevice(options);
  if (now) return now;
  updateJsonFile<Device>(file, (cur) => ({ ...cur, ...device }));
  return device;
}

/** Renames this computer (made first if need be); other keys of the file stay. Throws with the reason a name will not do. */
export function setDeviceName(name: string, options: { env?: Env } = {}): Device {
  const problem = deviceNameProblem(name);
  if (problem) throw new Error(problem);
  const device = ensureDevice(options);
  const next = { ...device, name: name.trim() };
  updateJsonFile<Device>(deviceFile(options.env), (cur) => ({ ...cur, ...next }));
  return next;
}
