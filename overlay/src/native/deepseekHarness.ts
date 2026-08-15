import { invoke } from "@tauri-apps/api/core";
import type { OpenPathResult } from "../types";

export type HarnessLabState = "notInstalled" | "stopped" | "running" | "portConflict" | "installationBroken" | "error";

export interface HarnessLabStatus {
  ok: boolean;
  state: HarnessLabState;
  installed: boolean;
  installedVersion: string | null;
  recommendedVersion: string;
  remoteVersion: string | null;
  updateAvailable: boolean;
  installedAhead: boolean;
  running: boolean;
  pid: number | null;
  url: string;
  port: number;
  executablePath: string | null;
  executablePaths: string[];
  multipleInstallations: boolean;
  packageRoot: string | null;
  npmGlobalRoot: string | null;
  dshHome: string;
  nodeAvailable: boolean;
  nodeVersion: string | null;
  npmAvailable: boolean;
  npmVersion: string | null;
  pnpmAvailable: boolean;
  pnpmVersion: string | null;
  installSource: string | null;
  message: string;
  recentLog: string;
}

export function loadHarnessLabStatus(): Promise<HarnessLabStatus> {
  return invoke<HarnessLabStatus>("harness_lab_status");
}

export function installGlobalHarness(): Promise<HarnessLabStatus> {
  return invoke<HarnessLabStatus>("install_global_harness");
}

export function startGlobalHarnessWeb(): Promise<HarnessLabStatus> {
  return invoke<HarnessLabStatus>("start_global_harness_web");
}

export function stopGlobalHarnessWeb(): Promise<HarnessLabStatus> {
  return invoke<HarnessLabStatus>("stop_global_harness_web");
}

export function checkHarnessRemoteVersion(): Promise<HarnessLabStatus> {
  return invoke<HarnessLabStatus>("check_harness_remote_version");
}

export function updateGlobalHarness(): Promise<HarnessLabStatus> {
  return invoke<HarnessLabStatus>("update_global_harness");
}

export function openHarnessLabWeb(): Promise<OpenPathResult> {
  return invoke<OpenPathResult>("open_harness_lab_web");
}
