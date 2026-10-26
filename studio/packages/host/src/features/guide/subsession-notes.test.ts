import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Session } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { roleCard } from "./role.js";

// 设置 → 子会话 (2026-10-26): the person's notes on models as sub-sessions reach the main model through its role card.

const PROFILES: ModelProfile[] = [
  { id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" },
  { id: "p-plain", label: "Plain", runtime: "codex", provider: "amo-plain", model: null },
];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let main: Session;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-subnotes-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  mkdirSync(join(root, "alpha"));
  const alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
  const task = store.createTask({ title: "改表", workspaceId: alpha.id });
  main = store.createSession({ taskId: task.id, topicId: null, parentId: null, kind: "main", runtime: "codex", profileId: "p-ds", workspaceId: alpha.id, title: "", status: "idle", writer: "workbench", runtimeRef: "thr-1" });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

describe("设置 → 子会话", () => {
  it("keeps one note per model of a known account, drops empty ones, and refuses unknown accounts and long notes", () => {
    const saved = service.config.updateSettings({
      subsessionNotes: [
        { profileId: "p-plain", model: "fake-slow", note: "  慢但便宜，照计划改代码  " },
        { profileId: "p-plain", model: "fake-slow", note: "重复的一条" },
        { profileId: "p-ds", model: null, note: "" },
        { profileId: "p-ds", model: null, note: "默认型号：快，适合查资料" },
      ],
    }).subsessionNotes;
    expect(saved).toEqual([
      { profileId: "p-plain", model: "fake-slow", note: "慢但便宜，照计划改代码" },
      { profileId: "p-ds", model: null, note: "默认型号：快，适合查资料" },
    ]);
    expect(() => service.config.updateSettings({ subsessionNotes: [{ profileId: "nope", model: null, note: "x" }] })).toThrow(/unknown profile/);
    expect(() => service.config.updateSettings({ subsessionNotes: [{ profileId: "p-ds", model: null, note: "长".repeat(1001) }] })).toThrow(/1000/);
  });

  it("shows the notes in the role card, with the model argument to use; a subagent's card has none", () => {
    expect(roleCard(service, main.id)).not.toContain("人写的模型用法");
    service.config.updateSettings({ subsessionNotes: [{ profileId: "p-plain", model: "fake-slow", note: "慢但便宜，\n照计划改代码" }, { profileId: "p-ds", model: null, note: "快" }] });
    const card = roleCard(service, main.id);
    expect(card).toContain("人写的模型用法");
    expect(card).toContain('- Plain/fake-slow（model: "Plain/fake-slow"）：慢但便宜， 照计划改代码');
    expect(card).toContain('- DS（model: "DS"）：快');
    const sub = store.createSession({ taskId: main.taskId, topicId: null, parentId: main.id, kind: "sub", runtime: "codex", profileId: "p-ds", workspaceId: main.workspaceId, title: "", status: "idle", writer: "workbench", runtimeRef: "thr-2" });
    expect(roleCard(service, sub.id)).not.toContain("人写的模型用法");
  });
});
