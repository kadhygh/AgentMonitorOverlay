import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Small JSON files several AMO programs read: written whole to a temp file and renamed over, so a reader never sees
// half of one.

export function readJsonFile<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")) as T;
  } catch {
    return null;
  }
}

export function writeJsonFile(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  try {
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Read, change, write back; keys the change does not touch stay as they were (another program may own them). */
export function updateJsonFile<T extends object>(file: string, change: (current: Partial<T>) => Partial<T>): Partial<T> {
  const current = readJsonFile<Partial<T>>(file);
  const next = change(current && typeof current === "object" ? current : {});
  writeJsonFile(file, next);
  return next;
}
