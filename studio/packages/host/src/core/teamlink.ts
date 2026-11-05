import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { accountFile, deviceFile, ensureDevice, readAccount, readDevice, setDeviceName, type Account, type Device, type Env, type Protector } from "@amo-studio/account";
import { HostError } from "./shared.js";

// The team server as this computer knows it (plans/host-structure.md 8a, 2026-11-05): the AMO platform's login
// (account.json, Studio has none of its own: AGENTS.md constraint 7) and this computer's device.json, watched for the
// changes the platform makes while Studio runs. 远程 (features/remote), 会话里用中转 (features/teamrelay) and 问题页
// (features/issues) all speak to the team server as the person through it; it used to live inside RemoteFeature, so
// 中转 and the 问题页 depended on 远程 being started.

export interface TeamLinkOptions {
  /** Where account.json and device.json are (AMO_HOME); default the Host's environment. */
  env?: Env;
  /** Tests: something other than DPAPI for the key. */
  protector?: Protector;
  /** How often to look at account.json and device.json for changes the platform made (default 5 s). */
  watchMs?: number;
}

export interface TeamLinkEvents {
  /** A read of account.json finished (also when nothing changed): the login now, and the one before. */
  account: [Account | null, Account | null];
  /** The platform changed device.json: its name, or (rarely) its id. */
  device: [Device, { idChanged: boolean }];
}

export class TeamLink extends EventEmitter<TeamLinkEvents> {
  private opts: TeamLinkOptions | null = null;
  private current: Account | null = null;
  private own: Device | null = null;
  private watch: NodeJS.Timeout | null = null;
  private seenFiles = "";
  private reading: Promise<void> | null = null;
  /** A first read of account.json has finished since start (until then, null means "not read yet"). */
  private read = false;

  /** Starts reading and watching the two files; again while started does nothing (the first options stay). */
  start(options: TeamLinkOptions = {}): void {
    if (this.opts) return;
    this.opts = options;
    this.read = false;
    try {
      this.own = ensureDevice({ env: options.env });
    } catch (err) {
      console.log(`team link: cannot make device.json: ${String(err)}`);
    }
    this.seenFiles = this.fileStamp();
    void this.reload();
    this.watch = setInterval(() => this.checkFiles(), options.watchMs ?? 5000);
    this.watch.unref();
  }

  stop(): void {
    if (this.watch) clearInterval(this.watch);
    this.watch = null;
    this.opts = null;
    this.current = null;
    this.read = false;
  }

  get started(): boolean {
    return !!this.opts;
  }
  /** A first read of account.json has finished. */
  get loaded(): boolean {
    return this.read;
  }
  /** The platform's login; null while not signed in, not read yet or not started. */
  get account(): Account | null {
    return this.current;
  }
  /** This computer's device (made at start when it was not there yet). */
  get device(): Device | null {
    return this.own;
  }
  get env(): Env | undefined {
    return this.opts?.env;
  }

  /** The login and this computer's device id, to speak to the team server as the person; null while not signed in. */
  login(): { account: Account; deviceId: string } | null {
    return this.current && this.own ? { account: this.current, deviceId: this.own.id } : null;
  }

  /** Waits for a read of account.json under way. */
  async settled(): Promise<void> {
    await this.reading;
  }

  /** Reads account.json again (one read at a time: DPAPI starts a PowerShell); `account` is emitted when it is done. */
  reload(): Promise<void> {
    const run = async () => {
      const opts = this.opts;
      if (!opts) return;
      const a = await readAccount({ env: opts.env, ...(opts.protector ? { protector: opts.protector } : {}) });
      // Stopped (or stopped and started again) while it read.
      if (this.opts !== opts) return;
      const before = this.current;
      this.current = a;
      this.read = true;
      this.emit("account", a, before);
    };
    this.reading = (this.reading ?? Promise.resolve()).then(run, run);
    return this.reading;
  }

  /** Renames this computer's device (device.json); what knows the name is told by the caller. */
  rename(name: string): Device {
    if (!this.opts) throw new HostError("bad_request", "这个 Host 没有连团队服务器");
    try {
      this.own = setDeviceName(name, { env: this.env });
    } catch (err) {
      throw new HostError("bad_request", err instanceof Error ? err.message : String(err));
    }
    this.seenFiles = this.fileStamp();
    return this.own;
  }

  // ---- account.json and device.json (the platform may change either while Studio runs)

  private fileStamp(): string {
    const stamp = (f: string) => {
      try {
        const s = statSync(f);
        return `${s.mtimeMs}:${s.size}`;
      } catch {
        return "-";
      }
    };
    return `${stamp(accountFile(this.env))}|${stamp(deviceFile(this.env))}`;
  }

  private checkFiles(): void {
    const now = this.fileStamp();
    if (now === this.seenFiles) return;
    const [accountBefore] = this.seenFiles.split("|");
    this.seenFiles = now;
    if (now.split("|")[0] !== accountBefore) void this.reload();
    const d = readDevice({ env: this.env });
    if (d && this.own && (d.name !== this.own.name || d.id !== this.own.id)) {
      const idChanged = d.id !== this.own.id;
      this.own = d;
      this.emit("device", d, { idChanged });
    }
  }
}
