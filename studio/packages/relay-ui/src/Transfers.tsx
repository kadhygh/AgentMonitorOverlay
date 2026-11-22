import { useEffect, useMemo, useState } from "react";
import { Avatar, timeText, useDisplayName, Who } from "./bits.js";
import { Check, Dialog, Field } from "./Dialog.js";
import { shell } from "./env.js";
import { DropZone } from "./Files.js";
import { errorText } from "./Messages.js";
import type { Session } from "./session.js";
import { myTarget, shellError, useTransferState, type LocalState, type TransferEngine } from "./transfer.js";
import { TRANSFER_MAX_BYTES, transferBytesText, transferTitle, type Member, type PickedSend, type RelayDevice, type Transfer, type TransferTarget } from "./shared.js";

// 传文件 (2026-11-23, plans/relay-file-transfer.md 第 2 项): the tab next to 待处理. On the left 等你确认 / 收到的 / 发出的
// and where received files go; on the right the sends of the one picked, each a card with who, which devices, what,
// how far, and what can be done (接收 / 拒绝, 取消, 停止接收, 打开文件夹, 重试). ＋ 发文件 opens the send dialog: files or
// folders (picked or dropped) → people → their devices (online ones marked, 全选) → 发出. Only the desktop client can
// read and write this computer's files: in a browser, or in a desktop program from before 传文件, the tab says so.

export type TransferFilter = "pending" | "in" | "out";
export type TransferAvailability = "ok" | "browser" | "oldShell" | "oldService" | "noDevice";

const MAX_LISTED = 300;

export function transferAvailability(s: { device: unknown; transfersOk: boolean }): TransferAvailability {
  if (!shell) return "browser";
  if (!shell.transfer) return "oldShell";
  if (!s.device) return "noDevice";
  return s.transfersOk ? "ok" : "oldService";
}

/** What waits for me on this device: sends to accept here. */
export function pendingHere(transfers: Transfer[], me: string, device: string | undefined): Transfer[] {
  return transfers.filter((t) => t.state === "open" && myTarget(t, me, device)?.state === "pending");
}

export function filterTransfers(transfers: Transfer[], f: TransferFilter, me: string, device: string | undefined): Transfer[] {
  if (f === "pending") return pendingHere(transfers, me, device);
  if (f === "out") return transfers.filter((t) => t.from === me);
  return transfers.filter((t) => t.targets.some((x) => x.account === me));
}

export function TransferNav(props: { session: Session; filter: TransferFilter; onFilter: (f: TransferFilter) => void; availability: TransferAvailability; toast: (t: string) => void }) {
  const { transfers, device } = props.session.snapshot;
  const me = props.session.me.name;
  const [dir, setDir] = useState<string | null>(null);
  const tx = shell?.transfer;
  useEffect(() => {
    if (props.availability === "ok") void tx?.receiveDir().then(setDir);
  }, [props.availability, tx]);
  if (props.availability !== "ok") return <div className="nav-empty">传文件只能在桌面客户端里用。</div>;
  const row = (f: TransferFilter, label: string) => (
    <button key={f} type="button" className="nav-row" aria-current={props.filter === f ? "true" : undefined} onClick={() => props.onFilter(f)}>
      <span className="name">{label}</span>
      <span className="count">{filterTransfers(transfers, f, me, device?.id).length}</span>
    </button>
  );
  const change = async () => {
    try {
      const picked = await tx!.chooseDir(dir ?? undefined);
      if (!picked) return;
      setDir(await tx!.setReceiveDir(picked));
      props.toast("以后收到的文件存到这里");
    } catch (err) {
      props.toast(shellError(err));
    }
  };
  return (
    <>
      <div className="nav-label">
        传文件
        <span className="rule" />
      </div>
      {row("pending", "等你确认")}
      {row("in", "收到的")}
      {row("out", "发出的")}
      <div className="xfer-dir">
        <div className="muted tiny">收到的文件默认存到</div>
        <div className="xfer-dir-path" title={dir ?? ""}>
          {dir ?? "…"}
        </div>
        <button type="button" className="small" onClick={() => void change()}>
          更改
        </button>
        <div className="muted tiny">这台电脑：{device?.name}</div>
      </div>
    </>
  );
}

export function TransferMain(props: { session: Session; engine: TransferEngine | null; filter: TransferFilter; availability: TransferAvailability; onSend: () => void; toast: (t: string) => void }) {
  const { transfers, device } = props.session.snapshot;
  const me = props.session.me.name;
  const local = useTransferState(props.engine);
  const [accepting, setAccepting] = useState<Transfer | null>(null);
  const [updatedBy, setUpdatedBy] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (props.availability === "oldShell") void shell?.info().then((i) => setUpdatedBy(i.updatedBy));
  }, [props.availability]);

  if (props.availability !== "ok") {
    const text =
      props.availability === "browser"
        ? "浏览器里打开的中转读写不了这台电脑上的文件。在 AMO 平台里安装 AMO 中转，用桌面客户端收发文件。"
        : props.availability === "oldShell"
          ? updatedBy === "platform"
            ? "传文件要新版的桌面程序：在 AMO 平台的「工具」里更新 AMO 中转，再打开它。"
            : "传文件要新版的桌面程序：在 AMO 平台里安装 AMO 中转，从平台打开（账号和记录都会留着）。"
          : props.availability === "noDevice"
            ? "读不到这台电脑的设备号（%APPDATA%\\AMO\\device.json），传文件用不了。重开一次中转试试。"
            : "中转服务还没更新到能传文件的版本，等管理员更新服务。";
    return (
      <div className="placeholder">
        <h2>传文件</h2>
        <p>{text}</p>
      </div>
    );
  }

  const list = filterTransfers(transfers, props.filter, me, device?.id);
  const title = props.filter === "pending" ? "等你确认" : props.filter === "in" ? "收到的" : "发出的";
  return (
    <section className="view">
      <div className="page-head">
        <div className="head-main">
          <h2 className="head-title">{title}</h2>
          <div className="head-meta">经服务器中转，一次最多 {transferBytesText(TRANSFER_MAX_BYTES)}，服务器只存 1 天。对方确认后才开始上传，中转要开着。</div>
        </div>
      </div>
      <div className="pane xfer-list">
        {list.map((t) => (
          <TransferCard key={t.id} t={t} me={me} device={device!.id} local={local.get(t.id)} session={props.session} engine={props.engine} onAccept={() => setAccepting(t)} toast={props.toast} />
        ))}
        {!list.length && (
          <div className="muted tiny">
            {props.filter === "pending" ? "没有等你确认的。" : props.filter === "in" ? "还没有收到过文件。" : "还没有发过文件。"}
            {props.filter !== "pending" && (
              <button type="button" className="link" onClick={props.onSend}>
                ＋ 发文件
              </button>
            )}
          </div>
        )}
      </div>
      {accepting && <AcceptDialog session={props.session} engine={props.engine!} transfer={transfers.find((x) => x.id === accepting.id) ?? accepting} onClose={() => setAccepting(null)} toast={props.toast} />}
    </section>
  );
}

const pct = (a: number, b: number) => (b > 0 ? Math.min(100, Math.floor((a / b) * 100)) : 100);
const hoursLeft = (t: Transfer) => Math.max(0, Math.ceil((t.expiresAt - Date.now()) / 3_600_000));

function targetText(x: TransferTarget, t: Transfer): string {
  if (x.state === "pending") return "等确认";
  if (x.state === "declined") return "拒绝了";
  if (x.state === "done") return "已收完";
  return `接收中 ${pct(x.got, t.totalSize)}%`;
}

function TransferCard(props: { t: Transfer; me: string; device: string; local: LocalState | undefined; session: Session; engine: TransferEngine | null; onAccept: () => void; toast: (t: string) => void }) {
  const { t, me, device, local } = props;
  const name = useDisplayName();
  const [busy, setBusy] = useState(false);
  const mineHere = myTarget(t, me, device);
  const sending = t.from === me;
  const sendingHere = sending && t.fromDevice === device;
  const uploaded = t.files.reduce((n, f) => n + f.received, 0);
  const allUp = t.files.every((f) => f.done);
  const accepted = t.targets.some((x) => x.state === "accepted");
  const tx = shell!.transfer!;

  const act = async (run: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await run();
      if (done) props.toast(done);
    } catch (err) {
      props.toast(shellError(errorText(err)));
    } finally {
      setBusy(false);
    }
  };

  // What this card says about where it is, from this device's side.
  let status: string;
  let bar: number | null = null;
  if (t.state === "cancelled") status = sending ? "已取消" : "发送方取消了";
  else if (t.state === "expired") status = "已过期（服务器只存 1 天）";
  else if (t.state === "done") status = mineHere?.state === "done" ? "已收到" : sending ? (t.targets.every((x) => x.state === "declined") ? "对方都拒绝了" : "都收到了") : mineHere?.state === "declined" ? "已拒绝" : "已结束";
  else if (mineHere) {
    if (mineHere.state === "pending") status = "等你确认：接收后对方才开始上传";
    else if (mineHere.state === "declined") status = "已拒绝";
    else if (mineHere.state === "done") status = "已收到";
    else {
      const got = local?.phase === "downloading" || local?.phase === "saving" ? local.bytes : mineHere.got;
      bar = pct(got, t.totalSize);
      status = local?.phase === "downloading" ? `接收中 ${transferBytesText(got)} / ${transferBytesText(t.totalSize)}` : allUp ? "下载中…" : uploaded > 0 ? `接收中：对方上传了 ${pct(uploaded, t.totalSize)}%` : "等对方开始上传（对方的中转要开着）";
    }
  } else if (sending) {
    if (!accepted) status = t.targets.some((x) => x.state === "pending") ? "等对方确认" : "没有设备在接收";
    else if (!allUp) {
      const up = sendingHere && local && local.phase !== "error" ? local.bytes : uploaded;
      bar = pct(up, t.totalSize);
      status = !sendingHere ? `在「${t.fromDeviceName}」上发送：那台的中转要开着（${pct(up, t.totalSize)}%）` : local?.phase === "hashing" ? `准备「${local.file}」…` : `上传中 ${transferBytesText(up)} / ${transferBytesText(t.totalSize)}`;
    } else status = "已传到服务器，等对方下载";
  } else {
    // Sent to my account, another device of mine.
    const mine = t.targets.filter((x) => x.account === me).map((x) => x.deviceName);
    status = `发到了你的「${mine.join("」「")}」，在那台上接收`;
  }
  const error = local?.phase === "error" ? local.error : null;

  return (
    <div className={`xfer-card st-${t.state}`} data-id={t.id}>
      <div className="xfer-top">
        <span className="file-ico">{t.roots.length > 1 || t.files.length !== 1 ? "DIR" : (t.roots[0]!.split(".").pop() ?? "").slice(0, 4)}</span>
        <div className="xfer-main">
          <div className="xfer-title">
            <b>{transferTitle(t)}</b>
            <span className="muted">
              {transferBytesText(t.totalSize)} · {t.files.length} 个文件
            </span>
          </div>
          <div className="xfer-who">
            <Avatar name={t.from} small />
            {sending ? "我" : <Who name={t.from} />}
            <span className="muted">（{t.fromDeviceName}）</span>
            <span className="muted">→</span>
            {t.targets.map((x) => (
              <span key={`${x.account}-${x.device}`} className={`xfer-target ts-${x.state}`} title={targetText(x, t)}>
                {x.account === me ? "我" : name(x.account)} · {x.deviceName}
                {(sending || x.account === me) && <span className="muted">：{targetText(x, t)}</span>}
              </span>
            ))}
          </div>
        </div>
        <span className="srow-time" title={new Date(t.createdAt).toLocaleString()}>
          {timeText(t.createdAt)}
        </span>
      </div>
      <div className="xfer-status">
        <span className="xfer-status-text">{status}</span>
        {t.state === "open" && <span className="muted tiny">还剩 {hoursLeft(t)} 小时</span>}
      </div>
      {bar !== null && (
        <div className="xfer-bar" role="progressbar" aria-valuenow={bar} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${bar}%` }} />
        </div>
      )}
      {error && <div className="notice error">{error}</div>}
      <div className="xfer-acts">
        {t.state === "open" && mineHere?.state === "pending" && (
          <>
            <button type="button" disabled={busy} onClick={() => void act(async () => props.session.putTransfer(await props.session.client.answerTransfer(t.id, device, false)), "已拒绝")}>
              拒绝
            </button>
            <button type="button" className="primary" disabled={busy} onClick={props.onAccept}>
              接收…
            </button>
          </>
        )}
        {t.state === "open" && mineHere?.state === "accepted" && (
          <button type="button" disabled={busy} onClick={() => void act(async () => props.session.putTransfer(await props.session.client.answerTransfer(t.id, device, false)), "已停止接收")}>
            停止接收
          </button>
        )}
        {(mineHere?.state === "done" || (mineHere?.state === "accepted" && t.state === "open")) && (
          <button type="button" disabled={busy} onClick={() => void act(() => tx.openFolder(t.id))}>
            打开文件夹
          </button>
        )}
        {error && props.engine && (
          <button type="button" onClick={() => props.engine!.retry(t.id)}>
            重试
          </button>
        )}
        {t.state === "open" && sending && (
          <button type="button" disabled={busy} onClick={() => void act(async () => props.session.putTransfer(await props.session.client.cancelTransfer(t.id)), "已取消发送")}>
            取消发送
          </button>
        )}
      </div>
    </div>
  );
}

function FileList({ entries, dirs }: { entries: Array<{ path: string; size: number }>; dirs: string[] }) {
  return (
    <div className="xfer-files">
      {entries.slice(0, MAX_LISTED).map((e) => (
        <div key={e.path} className="xfer-file">
          <span className="ellipsis">{e.path}</span>
          <span className="muted">{transferBytesText(e.size)}</span>
        </div>
      ))}
      {dirs.slice(0, Math.max(0, MAX_LISTED - entries.length)).map((d) => (
        <div key={`d:${d}`} className="xfer-file">
          <span className="ellipsis">{d}/</span>
          <span className="muted">空文件夹</span>
        </div>
      ))}
      {entries.length + dirs.length > MAX_LISTED && <div className="muted tiny">……还有 {entries.length + dirs.length - MAX_LISTED} 项</div>}
    </div>
  );
}

function AcceptDialog(props: { session: Session; engine: TransferEngine; transfer: Transfer; onClose: () => void; toast: (t: string) => void }) {
  const t = props.transfer;
  const tx = shell!.transfer!;
  const [dir, setDir] = useState<string | null>(null);
  const [keep, setKeep] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void tx.receiveDir().then((d) => setDir((cur) => cur ?? d)), [tx]);
  const ended = t.state !== "open" || myTarget(t, props.session.me.name, props.session.snapshot.device?.id)?.state !== "pending";
  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      if (keep) await tx.setReceiveDir(dir!);
      await props.engine.accept(t, dir!);
      props.toast("已接收，对方开始上传后这里会显示进度");
      props.onClose();
    } catch (err) {
      setError(shellError(errorText(err)));
    } finally {
      setBusy(false);
    }
  };
  const from = t.from === props.session.me.name ? `你的「${t.fromDeviceName}」` : `${t.from}（${t.fromDeviceName}）`;
  return (
    <Dialog
      title="接收文件"
      sub={`${from} 发来 ${transferTitle(t)}`}
      onClose={props.onClose}
      wide
      foot={
        <>
          <span className="grow" />
          <button type="button" onClick={props.onClose}>
            先不处理
          </button>
          <button type="button" className="primary" disabled={busy || !dir || ended} onClick={() => void accept()}>
            接收
          </button>
        </>
      }
    >
      <Field label={`${t.files.length} 个文件，共 ${transferBytesText(t.totalSize)}`} hint={`服务器存到 ${new Date(t.expiresAt).toLocaleString()}`}>
        <FileList entries={t.files} dirs={t.dirs} />
      </Field>
      <Field label="存到" hint="同名的会自动改成「名字 (1)」">
        <div className="xfer-dir-pick">
          <span className="xfer-dir-path" title={dir ?? ""}>
            {dir ?? "…"}
          </span>
          <button
            type="button"
            onClick={() =>
              void tx
                .chooseDir(dir ?? undefined)
                .then((d) => d && setDir(d))
                .catch((err: unknown) => setError(shellError(err)))
            }
          >
            换个文件夹
          </button>
        </div>
        <Check checked={keep} onChange={setKeep}>
          以后都存到这里
        </Check>
      </Field>
      {ended && <div className="notice error">这次传送已经不用确认了（结束了，或在别处处理过）。</div>}
      {error && <div className="notice error">{error}</div>}
    </Dialog>
  );
}

export function SendDialog(props: { session: Session; members: Member[]; onClose: () => void; onSent: () => void; toast: (t: string) => void }) {
  const tx = shell!.transfer!;
  const me = props.session.me.name;
  const here = props.session.snapshot.device!;
  const [picked, setPicked] = useState<PickedSend | null>(null);
  const [keep, setKeep] = useState<string[]>([]);
  const [devices, setDevices] = useState<RelayDevice[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = (account: string, id: string) => `${account}\n${id}`;

  // Who is online changes while the dialog is open.
  useEffect(() => {
    let gone = false;
    const load = () => void props.session.client.transferDevices().then((d) => !gone && setDevices(d)).catch((err: unknown) => !gone && setError(errorText(err)));
    load();
    const timer = setInterval(load, 5000);
    return () => ((gone = true), clearInterval(timer));
  }, [props.session]);

  const took = (p: PickedSend | null) => {
    if (!p) return;
    setPicked(p);
    setKeep((k) => [...new Set([...k, ...p.roots.map((r) => r.name)])].filter((n) => p.roots.some((r) => r.name === n)));
    if (p.skipped.length) props.toast(`没加上：${p.skipped.join("、")}`);
  };
  const pick = (run: () => Promise<PickedSend | null>) => void run().then(took).catch((err: unknown) => setError(shellError(err)));

  const entries = picked ? picked.entries.filter((e) => keep.includes(e.path.split("/")[0]!)) : [];
  const dirs = picked ? picked.dirs.filter((d) => keep.includes(d.split("/")[0]!)) : [];
  const total = entries.reduce((n, e) => n + e.size, 0);
  const tooBig = total > TRANSFER_MAX_BYTES;

  // People with their devices: me first (my other devices), then the team in its order.
  const people = useMemo(() => {
    const byAccount = new Map<string, RelayDevice[]>();
    for (const d of devices ?? []) {
      if (d.account === me && d.id === here.id) continue;
      byAccount.set(d.account, [...(byAccount.get(d.account) ?? []), d]);
    }
    const names = [me, ...props.members.map((m) => m.name).filter((n) => n !== me)];
    return names.map((n) => ({ name: n, devices: byAccount.get(n) ?? [] }));
  }, [devices, props.members, me, here.id]);

  const toggle = (k: string, on: boolean) => setChosen((c) => (on ? [...new Set([...c, k])] : c.filter((x) => x !== k)));
  const send = async () => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const targets = chosen.map((k) => {
        const [account, device] = k.split("\n");
        return { account: account!, device: device! };
      });
      const t = await props.session.client.createTransfer({ device: here.id, deviceName: here.name, entries, dirs, targets });
      await tx.bind(picked.pick, t.id, keep);
      props.session.putTransfer(t);
      props.onSent();
    } catch (err) {
      setError(shellError(errorText(err)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="发文件"
      onClose={props.onClose}
      wide
      className="xfer-send"
      foot={
        <>
          <span className="muted tiny">对方确认后才开始上传，上传完之前这边的中转要开着</span>
          <span className="grow" />
          <button type="button" onClick={props.onClose}>
            取消
          </button>
          <button type="button" className="primary" disabled={busy || !entries.length && !dirs.length || !chosen.length || tooBig} onClick={() => void send()}>
            发出
          </button>
        </>
      }
    >
      <Field label="发什么" hint={entries.length || dirs.length ? `${entries.length} 个文件，共 ${transferBytesText(total)}` : `文件或文件夹，一次最多 ${transferBytesText(TRANSFER_MAX_BYTES)}`}>
        <DropZone className="xfer-drop" onFiles={(fl) => pick(() => tx.dropped([...fl], picked?.pick))}>
          {picked && keep.length > 0 && (
            <div className="xfer-roots">
              {picked.roots
                .filter((r) => keep.includes(r.name))
                .map((r) => {
                  const size = picked.entries.filter((e) => e.path === r.name || e.path.startsWith(`${r.name}/`)).reduce((n, e) => n + e.size, 0);
                  return (
                    <button key={r.name} type="button" className="att on" title="点一下去掉" onClick={() => setKeep((k) => k.filter((x) => x !== r.name))}>
                      <span className="file-ico">{r.folder ? "DIR" : (r.name.split(".").pop() ?? "").slice(0, 4)}</span>
                      {r.name}
                      <span className="muted">· {transferBytesText(size)}</span>
                      <span className="x">×</span>
                    </button>
                  );
                })}
            </div>
          )}
          <div className="xfer-drop-acts">
            <button type="button" onClick={() => pick(() => tx.pickFiles(picked?.pick))}>
              选文件
            </button>
            <button type="button" onClick={() => pick(() => tx.pickFolder(picked?.pick))}>
              选文件夹
            </button>
            <span className="muted tiny">也可以把文件或文件夹拖到这里</span>
          </div>
        </DropZone>
        {tooBig && <div className="notice error">一次最多发 {transferBytesText(TRANSFER_MAX_BYTES)}，这次是 {transferBytesText(total)}：分几次发，或者去掉一些。</div>}
      </Field>
      <Field label="发给" hint="列出的是用过新版中转桌面客户端的设备；绿点是现在在线的">
        <div className="xfer-people">
          {devices === null && <div className="muted tiny">正在读设备…</div>}
          {devices !== null &&
            people.map((p) => {
              const keys = p.devices.map((d) => key(p.name, d.id));
              const all = keys.length > 0 && keys.every((k) => chosen.includes(k));
              return (
                <div key={p.name} className={`xfer-person ${p.devices.length ? "" : "none"}`} data-person={p.name}>
                  <div className="xfer-person-head">
                    <Avatar name={p.name} small />
                    <span className="grow">{p.name === me ? "我的其他设备" : <Who name={p.name} />}</span>
                    {p.devices.length > 1 && (
                      <Check checked={all} onChange={(on) => keys.forEach((k) => toggle(k, on))}>
                        全选
                      </Check>
                    )}
                  </div>
                  {p.devices.length ? (
                    <div className="xfer-devices">
                      {p.devices.map((d) => {
                        const k = key(p.name, d.id);
                        const on = chosen.includes(k);
                        return (
                          <button key={d.id} type="button" className={`att ${on ? "on" : ""}`} aria-pressed={on} onClick={() => toggle(k, !on)} title={d.online ? "在线" : `上次在线：${timeText(d.lastSeen)}`}>
                            <span className={`dot ${d.online ? "on" : ""}`} />
                            {d.name}
                            {!d.online && <span className="muted">· {timeText(d.lastSeen)}</span>}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="muted tiny">{p.name === me ? "你还没有在别的电脑上用过新版中转" : "还没有在新版中转桌面客户端上登录过"}</div>
                  )}
                </div>
              );
            })}
        </div>
      </Field>
      {error && <div className="notice error">{error}</div>}
    </Dialog>
  );
}
