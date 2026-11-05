import { randomBytes } from "node:crypto";
import { REMOTE_KINDS, remoteProfileId, type AccountUsage, type ChannelBalance, type Id, type RemotePeerUsage, type RemotePush, type RemoteUsage } from "@amo-studio/protocol";
import type { DeviceRef } from "@amo-studio/relay";
import type { RemoteContext, RemoteGrants } from "./grants.js";

// 远程额度 (2026-11-06, the user: 如果这个模型的额度被被控端追踪了，那么直接显示被控端的信息，而不需要要求被控端主动去调用
// 刷新或者查询). As A: the quota this computer already has in memory — the subscriptions' last reads (Codex's
// rateLimits, Claude's /usage or rate_limit_event) and the channels' last balance — for the models of the tasks granted
// to a device, pushed to it whenever it changes. Never asked for: nothing here reads an account or a site for B (the
// runtimes' cachedUsage, ChannelsFeature.cachedBalance). As B: what came, in memory, for the task page's 远程 line.
//
// To whom (sharesUsage; the user, 2026-11-06): a device of this computer's own account, always; a paired device of
// another account only once the person ticked 「让它看我的模型额度」 for it on the 远程 dialog (kv `remote.usageShare`,
// off by default) — the quota is the subscription of the person who owns A. Unticked, it is told an empty push at once
// (and again whenever it asks for its list), so what it had goes.

const SHARE_KEY = "remote.usageShare";

/** How often A looks whether its cached quota changed (memory only: no account is asked). Changes go out together. */
const POLL_MS = 10_000;
/** After B asked for its list or a task: what it has is told again this soon. */
const SOON_MS = 1_000;

const keyOf = (d: DeviceRef) => `${d.account}\n${d.device}`;

/** Whether this computer's quota may go to `to`: a device of the same account, or one the person let see it (`shared`). */
export function sharesUsage(ownAccount: string | null, to: DeviceRef, shared: readonly DeviceRef[] = []): boolean {
  return (!!ownAccount && to.account === ownAccount) || shared.some((d) => d.account === to.account && d.device === to.device);
}

/** What one profile's cached quota says: the account in use, only when it was read and has windows. */
function shown(cached: AccountUsage | AccountUsage[] | null | undefined): AccountUsage | null {
  const list = Array.isArray(cached) ? cached : cached ? [cached] : [];
  const u = list.find((x) => !x.account || x.account.current);
  if (!u || !u.updatedAt || !u.windows.length) return null;
  // Which of A's Claude accounts it is stays on A.
  const { account: _account, ...rest } = u;
  return rest;
}

export class RemoteUsageSender {
  /** What each device was told last (its stamp); gone when it went away, so it is told again when back. */
  private readonly told = new Map<string, string>();
  /** Devices told some numbers (an empty push then clears them there). */
  private readonly sent = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly ctx: RemoteContext,
    private readonly grants: RemoteGrants,
  ) {}

  start(pollMs = POLL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.timer = null;
    this.soon = null;
    this.told.clear();
  }

  /** The devices of other accounts the person let see the quota (远程 dialog). */
  shared(): DeviceRef[] {
    try {
      const v = JSON.parse(this.ctx.host.store.getKv(SHARE_KEY)?.value ?? "[]") as unknown;
      return Array.isArray(v) ? v.flatMap((d): DeviceRef[] => (d && typeof d.account === "string" && typeof d.device === "string" ? [{ account: d.account, device: d.device }] : [])) : [];
    } catch {
      return [];
    }
  }

  /** Lets `to` see the quota or not. Off: told an empty push now, so it drops what it had; on: told soon. */
  setShared(to: DeviceRef, on: boolean): void {
    const rest = this.shared().filter((d) => keyOf(d) !== keyOf(to));
    this.ctx.host.store.setKv(SHARE_KEY, JSON.stringify(on ? [...rest, { account: to.account, device: to.device }] : rest));
    if (on) this.again(to);
    else if (!sharesUsage(this.ctx.ownAccount(), to)) this.clear(to);
  }

  /** May `to` see the quota now. */
  private allows(to: DeviceRef): boolean {
    return sharesUsage(this.ctx.ownAccount(), to, this.shared());
  }

  /** An empty push to `to` (when it is there): whatever it has of this computer's quota goes. */
  private clear(to: DeviceRef): void {
    this.told.delete(keyOf(to));
    this.sent.delete(keyOf(to));
    const link = this.ctx.link();
    if (!link || link.state !== "online" || !this.ctx.peer(to)?.online) return;
    const push: RemotePush = { type: "usage", usage: [], balances: [] };
    link.send({ type: "relay", to: { account: to.account, device: to.device }, id: `p_${randomBytes(8).toString("hex")}`, kind: REMOTE_KINDS.push, body: push });
  }

  /**
   * The device asked for its list or a task (it came back, restarted, or got a new copy): it hears it all again — or,
   * not allowed (any more), an empty push, in case it still has numbers from before it was unticked while away.
   */
  again(from: DeviceRef): void {
    if (!this.allows(from)) return this.clear(from);
    this.told.delete(keyOf(from));
    if (this.soon || !this.timer) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      this.tick();
    }, SOON_MS);
    this.soon.unref?.();
  }

  /** The cached quota of these profiles (A's ids), as it goes to a device. */
  collect(profileIds: Iterable<Id>): RemoteUsage {
    const host = this.ctx.host;
    const usage: AccountUsage[] = [];
    const balances: ChannelBalance[] = [];
    for (const pid of [...new Set(profileIds)].sort()) {
      let u: AccountUsage | null = null;
      try {
        u = shown(host.runtime.cachedUsage?.(pid));
      } catch {
        // a profile gone meanwhile: nothing to show
      }
      if (u) usage.push(u);
      const b = host.channels.cachedBalance(pid);
      if (b) balances.push(b);
    }
    return { usage, balances };
  }

  /** The profiles the sessions of the tasks granted to `to` run on (A's ids). */
  private profilesFor(to: DeviceRef): Set<Id> {
    const ids = new Set<Id>();
    for (const g of this.grants.list()) {
      if (g.account !== to.account || g.device !== to.device) continue;
      for (const s of this.ctx.host.store.listSessions({ taskId: g.taskId })) if (!s.archivedAt && s.runtime !== "remote") ids.add(s.profileId);
    }
    return ids;
  }

  /** Each device allowed (sharesUsage) with a grant, online: told what changed since it was last told. */
  tick(): void {
    const link = this.ctx.link();
    if (!link || link.state !== "online") {
      this.told.clear();
      return;
    }
    const own = this.ctx.ownAccount();
    const shared = this.shared();
    const devices = new Map<string, DeviceRef>();
    for (const g of this.grants.list()) if (sharesUsage(own, g, shared)) devices.set(keyOf(g), { account: g.account, device: g.device });
    for (const key of [...this.told.keys()]) if (!devices.has(key)) this.told.delete(key);
    for (const [key, to] of devices) {
      if (!this.ctx.peer(to)?.online) {
        this.told.delete(key);
        continue;
      }
      const body = this.collect(this.profilesFor(to));
      const stamp = JSON.stringify(body);
      if (this.told.get(key) === stamp) continue;
      const empty = !body.usage.length && !body.balances.length;
      this.told.set(key, stamp);
      // Nothing to show and nothing shown before: nothing to say.
      if (empty && !this.sent.has(key)) continue;
      if (empty) this.sent.delete(key);
      else this.sent.add(key);
      const push: RemotePush = { type: "usage", ...body };
      link.send({ type: "relay", to, id: `p_${randomBytes(8).toString("hex")}`, kind: REMOTE_KINDS.push, body: push });
    }
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** As B: the quota paired devices pushed, in memory (a restart forgets it; A tells it again when this one asks for its list). */
export class RemoteUsageCopies {
  private readonly byPeer = new Map<string, RemotePeerUsage>();
  /** What came changed (the remote state is told again). */
  onChange: (() => void) | null = null;

  /** A `usage` push from `peer`: it replaces what that device said before. Anything odd in it is left out. */
  receive(peer: DeviceRef, body: unknown): void {
    const b = isObj(body) ? body : {};
    const usage = (Array.isArray(b.usage) ? b.usage : []).flatMap((u): AccountUsage[] => {
      if (!isObj(u) || typeof u.profileId !== "string" || typeof u.label !== "string" || !Array.isArray(u.windows)) return [];
      const windows = u.windows.filter((w): w is AccountUsage["windows"][number] => isObj(w) && typeof w.label === "string" && (w.usedPercent === null || typeof w.usedPercent === "number"));
      return [{ profileId: remoteProfileId(peer.device, u.profileId), label: u.label, windows, note: typeof u.note === "string" ? u.note : null, updatedAt: typeof u.updatedAt === "string" ? u.updatedAt : null }];
    });
    const balances = (Array.isArray(b.balances) ? b.balances : []).flatMap((x): ChannelBalance[] => {
      if (!isObj(x) || typeof x.profileId !== "string" || x.ok !== true || typeof x.unit !== "string") return [];
      const num = (v: unknown) => (typeof v === "number" ? v : null);
      return [{ profileId: remoteProfileId(peer.device, x.profileId), ok: true, remaining: num(x.remaining), used: num(x.used), total: num(x.total), unit: x.unit, planName: typeof x.planName === "string" ? x.planName : null, message: null, checkedAt: typeof x.checkedAt === "string" ? x.checkedAt : new Date().toISOString() }];
    });
    const key = keyOf(peer);
    if (!usage.length && !balances.length) {
      if (!this.byPeer.delete(key)) return;
    } else {
      this.byPeer.set(key, { account: peer.account, device: peer.device, usage, balances, receivedAt: new Date().toISOString() });
    }
    this.onChange?.();
  }

  list(): RemotePeerUsage[] {
    return [...this.byPeer.values()];
  }

  /** No longer paired. */
  forget(peer: DeviceRef): void {
    if (this.byPeer.delete(keyOf(peer))) this.onChange?.();
  }
}
