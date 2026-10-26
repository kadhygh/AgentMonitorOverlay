import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelProfile, Task, Workspace } from "@amo-studio/protocol";
import { removeTempDir } from "@amo-studio/testkit";
import { CodexRuntime } from "../../runtime/codex/codex-runtime.js";
import { FakeServers } from "../../runtime/codex/fake-servers.test-support.js";
import { HostService } from "../../service.js";
import { Store } from "../../store/store.js";
import { SCHEDULER_TASK_KEY } from "../../core/shared.js";

// 进行中 ⇄ 待审阅 by the sessions (2026-10-26): Studio moves the card when the task's sessions all stop, and back when
// one starts again.

const PROFILES: ModelProfile[] = [{ id: "p-ds", label: "DS", runtime: "codex", provider: "amo-ds", model: "ds-model" }];

let root: string;
let store: Store;
let servers: FakeServers;
let service: HostService;
let alpha: Workspace;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "amo-studio-test-columns-"));
  store = new Store(join(root, "studio.db"));
  servers = new FakeServers(PROFILES);
  service = new HostService(store, new CodexRuntime({ store, servers, profiles: PROFILES }), PROFILES, { commonDir: join(root, "common") });
  service.tasks.reviewSettleMs = 100;
  mkdirSync(join(root, "alpha"));
  alpha = store.addWorkspace({ path: join(root, "alpha"), name: "alpha" });
});

afterEach(async () => {
  await servers.close();
  store.close();
  removeTempDir(root);
});

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(pred()).toBe(true);
};
const column = (task: Task) => store.getTask(task.id)?.column;
const status = (id: string) => store.getSession(id)?.status;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("进行中 ⇄ 待审阅", () => {
  it("goes to 待审阅 once the turn is over, and back to 进行中 when the person talks to it again", async () => {
    const task = store.createTask({ title: "改表", workspaceId: alpha.id, column: "doing" });
    const s = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    await service.sessions.sendMessage(s.id, "[[slow]]");
    await until(() => status(s.id) === "running");
    await pause(250);
    expect(column(task)).toBe("doing");
    await service.sessions.interrupt(s.id);
    await until(() => column(task) === "review");

    await service.sessions.sendMessage(s.id, "[[slow]]");
    await until(() => column(task) === "doing");
    await service.sessions.interrupt(s.id);
    await until(() => column(task) === "review");
  });

  it("stays 进行中 while another session of the task still works", async () => {
    const task = store.createTask({ title: "两个会话", workspaceId: alpha.id, column: "doing" });
    const a = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    const b = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    await service.sessions.sendMessage(a.id, "[[slow]]");
    await service.sessions.sendMessage(b.id, "很快答完");
    await until(() => status(a.id) === "running");
    await until(() => status(b.id) === "idle" || status(b.id) === "completed");
    await pause(300);
    expect(column(task)).toBe("doing");
    await service.sessions.interrupt(a.id);
    await until(() => column(task) === "review");
  });

  it("leaves 待办, 完成 and the scheduler's task alone, and a card the person moved until a session starts or stops", async () => {
    const done = store.createTask({ title: "已完成", workspaceId: alpha.id, column: "done" });
    const d = await service.tasks.addSession(done.id, { profileId: "p-ds" });
    const scheduler = store.createTask({ title: "调度", workspaceId: alpha.id, column: "doing" });
    store.setKv(SCHEDULER_TASK_KEY, scheduler.id);
    const sch = await service.tasks.addSession(scheduler.id, { profileId: "p-ds" });
    await service.sessions.sendMessage(d.id, "再看一眼");
    await service.sessions.sendMessage(sch.id, "排一下");
    await until(() => status(d.id) === "idle" && status(sch.id) === "idle");
    await pause(300);
    expect(column(done)).toBe("done");
    expect(column(scheduler)).toBe("doing");

    // Moved back to 进行中 by the person while nothing runs: it stays there; renaming a session changes nothing.
    const task = store.createTask({ title: "手动", workspaceId: alpha.id, column: "review" });
    const s = await service.tasks.addSession(task.id, { profileId: "p-ds" });
    service.tasks.updateTask(task.id, { column: "doing" });
    await service.sessions.renameSession(s.id, "改个名");
    await pause(300);
    expect(column(task)).toBe("doing");
  });
});
