import { EventEmitter } from "node:events";
import type { ModelProfile } from "@amo-studio/protocol";
import { startFakeAppServer, type FakeAppServer } from "@amo-studio/testkit";
import type { CodexServers } from "./codex-runtime.js";
import { CodexRpcClient } from "./rpc-client.js";
import type { CodexServerHandle } from "./server-manager.js";

// Test support (not shipped): CodexServers backed by one fake app-server per profile, with the profile's provider as
// the server default, as the real CodexServerManager does.

export class FakeServers extends EventEmitter<{ ready: [CodexServerHandle] }> implements CodexServers {
  fakes = new Map<string, FakeAppServer>();
  handles = new Map<string, CodexServerHandle>();

  constructor(private readonly profiles: readonly ModelProfile[]) {
    super();
  }

  async ensure(profileId: string): Promise<CodexServerHandle> {
    const known = this.handles.get(profileId);
    if (known?.client.isOpen) return known;
    let fake = this.fakes.get(profileId);
    if (!fake) {
      const profile = this.profiles.find((p) => p.id === profileId)!;
      fake = await startFakeAppServer({ defaultProvider: profile.provider ?? "openai" });
      this.fakes.set(profileId, fake);
    }
    const client = await CodexRpcClient.connect({ url: fake.url, token: fake.token });
    const handle: CodexServerHandle = { profileId, url: fake.url, port: fake.port, token: fake.token, client };
    this.handles.set(profileId, handle);
    this.emit("ready", handle);
    return handle;
  }

  async close(): Promise<void> {
    for (const h of this.handles.values()) h.client.close();
    for (const f of this.fakes.values()) await f.close();
  }
}
