import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { DshStatus, ModelProfile } from "@amo-studio/protocol";
import { DSH_OPTIONS_KEY, DSH_PATH_KEY, describeDsh, dshStatus } from "../../runtime/dsh/install.js";
import { HostError } from "../../core/shared.js";
import { Feature } from "../../core/feature.js";

/**
 * 设置 → 模型 → DeepSeek Harness (stage 17): the DSH source clone DeepSeek · DSH sessions run on — where it is, what
 * version and commit it has, whether it is built, and 「检查」 after the person pulls a new version.
 */
export class DshFeature extends Feature {
  status(): DshStatus {
    return dshStatus(this.store);
  }

  /** Sets the clone's folder (null clears it). The DSH profile shows in the pickers once the clone is built. */
  setPath(value: unknown): DshStatus {
    if (value === null || value === "") {
      this.store.setKv(DSH_PATH_KEY, "");
    } else {
      if (typeof value !== "string" || value.length > 1000) throw new HostError("bad_request", "path must be a folder path or null");
      const path = resolve(value.trim());
      if (!existsSync(path) || !statSync(path).isDirectory()) throw new HostError("bad_request", `找不到文件夹 ${path}`);
      if (!describeDsh(path)) throw new HostError("bad_request", `${path} 不是 DSH 源码克隆（里面没有 apps/cli）`);
      this.store.setKv(DSH_PATH_KEY, path);
    }
    // Models of another clone may differ: the next 「检查」 or session tells them again.
    this.store.setKv(DSH_OPTIONS_KEY, "null");
    this.profilesChanged();
    return this.status();
  }

  async check(): Promise<DshStatus> {
    const runtime = this.options.dsh;
    if (!runtime) throw new HostError("read_only", "这个 Host 没有 DSH 运行时");
    await runtime.check();
    this.profilesChanged();
    return this.status();
  }

  private profilesChanged(): void {
    this.options.channels?.refresh();
    this.publish({ type: "profiles.updated", profiles: [...this.profiles] as ModelProfile[] });
  }
}
