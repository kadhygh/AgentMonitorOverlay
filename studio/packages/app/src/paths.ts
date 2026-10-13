import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

// Where Studio keeps its data. Order: AMO_STUDIO_DATA_DIR; in the portable build, the choice saved next to the exe
// (amo-studio.json), else `data/` next to the exe; in development, studio/.data. A portable copy carries its data with
// it when the whole folder is moved.

export const PORTABLE_CONFIG = "amo-studio.json";

export interface PortableConfig {
  /** Absolute, or relative to the exe's folder. */
  dataDir: string;
}

export interface DataDirInput {
  env: Record<string, string | undefined>;
  /** The portable build's folder (the exe's); null in development. */
  portableDir: string | null;
  studioRoot: string;
}

export interface DataDirChoice {
  dataDir: string;
  source: "env" | "config" | "portable-default" | "dev";
  /** Portable build only: where the choice is (or would be) saved. */
  configPath: string | null;
  /** Portable build without a saved choice: the first-run setup should ask. */
  firstRun: boolean;
}

export function readPortableConfig(path: string): PortableConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) as Partial<PortableConfig>;
    return typeof raw.dataDir === "string" && raw.dataDir.trim() ? { dataDir: raw.dataDir.trim() } : null;
  } catch {
    return null;
  }
}

export function writePortableConfig(path: string, config: PortableConfig): void {
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function resolveDataDir(input: DataDirInput): DataDirChoice {
  const configPath = input.portableDir ? join(input.portableDir, PORTABLE_CONFIG) : null;
  const fromEnv = input.env.AMO_STUDIO_DATA_DIR;
  if (fromEnv) return { dataDir: resolve(fromEnv), source: "env", configPath, firstRun: false };
  if (!input.portableDir) return { dataDir: join(input.studioRoot, ".data"), source: "dev", configPath: null, firstRun: false };
  const saved = readPortableConfig(configPath!);
  if (saved) return { dataDir: isAbsolute(saved.dataDir) ? saved.dataDir : resolve(input.portableDir, saved.dataDir), source: "config", configPath, firstRun: false };
  return { dataDir: join(input.portableDir, "data"), source: "portable-default", configPath, firstRun: true };
}

/** A data dir the person picked: absolute, writable (created if missing). Saved relative when inside the portable folder. */
export function acceptDataDir(choice: string, portableDir: string): { dataDir: string; saved: string } {
  const dataDir = resolve(portableDir, choice.trim());
  mkdirSync(dataDir, { recursive: true });
  accessSync(dataDir, constants.W_OK);
  const rel = relative(portableDir, dataDir);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  return { dataDir, saved: inside ? rel : dataDir };
}
