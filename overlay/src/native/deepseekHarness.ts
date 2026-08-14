import { invoke } from "@tauri-apps/api/core";
import type { OpenPathResult } from "../types";

export type HarnessLabState = "notInstalled" | "stopped" | "starting" | "running" | "portConflict" | "error";

export interface HarnessLabStatus {
  ok: boolean;
  state: HarnessLabState;
  installed: boolean;
  installedVersion: string | null;
  expectedVersion: string;
  remoteVersion: string | null;
  updateAvailable: boolean;
  running: boolean;
  owned: boolean;
  pid: number | null;
  url: string;
  port: number;
  runtimePath: string;
  dataPath: string;
  dshHome: string;
  nodeAvailable: boolean;
  nodeVersion: string | null;
  npmAvailable: boolean;
  deepseekKeyConfigured: boolean;
  glmKeyConfigured: boolean;
  glmProviderConfigured: boolean;
  message: string;
  recentLog: string;
}

export function loadHarnessLabStatus(): Promise<HarnessLabStatus> {
  return invoke<HarnessLabStatus>("harness_lab_status");
}

export function installHarnessLabRuntime(): Promise<HarnessLabStatus> {
  return invoke<HarnessLabStatus>("install_harness_lab_runtime");
}

export function checkHarnessLabRemoteVersion(): Promise<HarnessLabStatus> {
  return invoke<HarnessLabStatus>("check_harness_lab_remote_version");
}

export function updateHarnessLabRuntime(): Promise<HarnessLabStatus> {
  return invoke<HarnessLabStatus>("update_harness_lab_runtime");
}

export function startHarnessLabService(): Promise<HarnessLabStatus> {
  return invoke<HarnessLabStatus>("start_harness_lab_service");
}

export function stopHarnessLabService(): Promise<HarnessLabStatus> {
  return invoke<HarnessLabStatus>("stop_harness_lab_service");
}

export function openHarnessLabWeb(): Promise<OpenPathResult> {
  return invoke<OpenPathResult>("open_harness_lab_web");
}
