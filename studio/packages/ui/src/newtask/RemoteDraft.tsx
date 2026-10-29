import { useEffect, useRef, useState } from "react";
import type { RemoteCatalog, RemoteState, Task } from "@amo-studio/protocol";
import { call, HostApiError, type HostLink } from "../host/client.js";
import { StartingCover } from "../lib/StartingCover.js";
import { IconPaperclip } from "../attach/icons.js";
import { useAttachments } from "../attach/useAttachments.js";
import { AttachTray } from "../attach/AttachTray.js";
import { withFileRefs } from "../attach/refs.js";
import { topicProject } from "./choices.js";
import { ChoiceRow } from "./ChoiceRow.js";
import type { TaskDraft } from "./draft.js";
import { catalogProblem, catalogProjectChoices, catalogTopicChoices, defaultProject, PRESENCE_TAG, remoteTargets, targetKey } from "./remoteTargets.js";

// 新任务页的「在别的设备上」 (plans/remote-page-and-new-task.md 4.1, 2026-10-29): 设备 first (paired devices that allowed
// this computer; offline ones greyed), then 专题 / 项目 / 第一句话 / 模型 as on this computer, but from what that device
// allows (its catalog, fetched when it is picked). Enter creates the task there: it is granted to this computer and its
// session starts there; the page opens its copy here once the copy has come. No pictures or files (as in a remote
// task's conversation) and no @ (what it would point at is on this computer).

const LAST_DEVICE = "amo.remoteDraftDevice";
/** How long to wait for the copy to show up here after the device made the task. */
const COPY_WAIT_MS = 15_000;

const message = (err: unknown) => (err instanceof HostApiError ? err.message : String(err));

function lastDevice(): string | null {
  try {
    return localStorage.getItem(LAST_DEVICE);
  } catch {
    return null;
  }
}

function rememberDevice(key: string): void {
  try {
    localStorage.setItem(LAST_DEVICE, key);
  } catch {
    // per-viewer convenience only
  }
}

type Loaded = { key: string; catalog: RemoteCatalog | null; error: string | null };

export function RemoteDraft({
  link,
  remote,
  initialDevice,
  tasks,
  draft,
  update,
  onDone,
  onOpenTask,
}: {
  link: HostLink;
  remote: RemoteState;
  /** The device card's 「在它上面新建任务」: that device picked. */
  initialDevice?: { account: string; device: string };
  /** To see the copy arrive. */
  tasks: readonly Task[];
  /** The task's name and first sentence are the shared draft's (switching back and forth keeps them). */
  draft: TaskDraft;
  update(patch: Partial<TaskDraft>): void;
  /** Created there: the draft is emptied. */
  onDone(): void;
  onOpenTask(taskId: string, sessionId: string | null): void;
}) {
  const targets = remoteTargets(remote);
  const [deviceKey, setDeviceKey] = useState<string | null>(() => {
    const keys = targets.map((t) => t.key);
    const wanted = initialDevice ? targetKey(initialDevice) : null;
    if (wanted && keys.includes(wanted)) return wanted;
    const last = lastDevice();
    const online = targets.filter((t) => t.presence === "online");
    if (last && online.some((t) => t.key === last)) return last;
    return online[0]?.key ?? null;
  });
  const target = targets.find((t) => t.key === deviceKey) ?? null;
  const online = target?.presence === "online";
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);
  const catalog = loaded && loaded.key === deviceKey ? loaded.catalog : null;
  const loadError = loaded && loaded.key === deviceKey ? loaded.error : null;
  const [topicId, setTopicId] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [profileId, setProfileId] = useState<string | null>(null);
  const pickedByHand = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [opening, setOpening] = useState<{ taskId: string; sessionId: string | null; name: string } | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Pictures and files go along (2026-10-29 evening): this computer's Host sends them to the device before the task.
  const attach = useAttachments(link);
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  // The device's catalog, each time it is picked (or comes online).
  useEffect(() => {
    if (!target || !online) return;
    let cancelled = false;
    const key = target.key;
    setLoaded(null);
    call(link, "GET /api/remote/catalog", {}, undefined, { account: target.account, device: target.device })
      .then((c) => {
        if (cancelled) return;
        setLoaded({ key, catalog: c, error: null });
        setTopicId(null);
        setProjectId(defaultProject(c));
        setProfileId(c.models[0]?.id ?? null);
        pickedByHand.current = false;
      })
      .catch((err: unknown) => !cancelled && setLoaded({ key, catalog: null, error: message(err) }));
    return () => {
      cancelled = true;
    };
    // By the device and whether it is online; `attempt` asks again (重试).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.key, online, attempt, link.url]);

  useEffect(() => input.current?.focus(), []);

  // The copy is here: open it. Not after a while: say so (it still comes with the next sync).
  const open = useRef(onOpenTask);
  open.current = onOpenTask;
  const arrived = !!opening && tasks.some((t) => t.id === opening.taskId);
  useEffect(() => {
    if (!opening) return;
    if (arrived) {
      open.current(opening.taskId, opening.sessionId);
      return;
    }
    const t = setTimeout(() => {
      setOpening(null);
      setBusy(false);
      setError(`任务已经在 ${opening.name} 上建好并开跑了，但还没同步到这台电脑：稍后会出现在看板上（顶栏「远程」→「在别的设备上跑的」里也有）。`);
    }, COPY_WAIT_MS);
    return () => clearTimeout(t);
  }, [opening, arrived]);

  const pickDevice = (key: string) => {
    if (key === deviceKey) return;
    setDeviceKey(key);
    rememberDevice(key);
    setError("");
  };

  const pickTopic = (id: string | null) => {
    setTopicId(id);
    if (pickedByHand.current || !catalog) return;
    // The topic's one allowed project, as on this computer (4.2); none or several: the person picks.
    const only = topicProject(catalog.topics.find((t) => t.id === id)?.workspaceIds ?? []);
    setProjectId(only ?? defaultProject(catalog));
  };

  const problem = catalog ? catalogProblem(catalog) : null;
  const noCommon = catalog && !catalog.allowCommon ? `${catalog.name} 不允许不选项目（公共文件夹）：选一个项目` : undefined;

  async function submit() {
    if (busy) return;
    if (!target) return setError("先选一台设备。");
    if (!online) return setError(`${target.name} 不在线：要它开着 Studio、连上团队服务器才能在它上面建任务。`);
    if (!catalog) return setError(loadError ?? `还在从 ${target.name} 读取能选的项目和模型，稍等一下。`);
    if (problem) return setError(problem);
    if (!draft.text.trim()) return setError("写一句话再开始。");
    if (projectId === null && noCommon) return setError(`先选一个项目：${noCommon}。`);
    if (!profileId) return setError("先选一个模型。");
    if (attach.uploading) return setError("图片还在准备，稍等一下。");
    if (attach.failed) return setError("有图片没能加上，移除后再开始。");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const images = attach.images.flatMap((i) => (i.id ? [i.id] : []));
      const text = withFileRefs(draft.text.trim(), attach.files.map(attach.refOf));
      const made = await call(link, "POST /api/remote/create", {}, { account: target.account, device: target.device, title: draft.title.trim(), text, topicId, workspaceId: projectId, profileId, ...(images.length ? { attachments: images } : {}) });
      rememberDevice(target.key);
      attach.reset();
      onDone();
      // 安全 (2026-10-29): that computer wants a yes there first — nothing is made yet; 远程 shows it waiting.
      if (made.waiting || !made.taskId) {
        setBusy(false);
        setNotice(`已发给 ${catalog.name}：要那边同意后才建任务、开跑（${catalog.name} 的 Focus 和「远程」里会提示）。同意后它出现在这台电脑的看板上；等的时候可以在顶栏「远程」里看到和撤回。`);
        return;
      }
      if (made.error) {
        // The task is there and granted (its card comes to the board): its session can be started from its page.
        setBusy(false);
        setError(`任务已经在 ${catalog.name} 上建好，但会话没能启动：${made.error}。它会出现在看板上，可以在任务页里再开会话。`);
        return;
      }
      setOpening({ taskId: made.taskId, sessionId: made.sessionId, name: catalog.name });
    } catch (err) {
      setError(message(err));
      setBusy(false);
    }
  }

  const projectName = catalog?.projects.find((p) => p.id === projectId)?.name;
  const topicTitle = catalog?.topics.find((t) => t.id === topicId)?.title;
  const where = target && catalog ? `在 ${catalog.name} 上${projectName ? `的 ${projectName} 里` : "的公共目录里"}运行${topicTitle ? ` · 放进那边的「${topicTitle}」` : ""}` : target ? `在 ${target.name} 上运行` : "";

  return (
    <>
      <div className="draft-where" data-testid="remote-draft">
        <div className="pick-row" role="group" aria-label="设备">
          <span className="pick-lab">设备</span>
          {targets.map((t) => (
            <button
              key={t.key}
              type="button"
              className="chip"
              aria-pressed={t.key === deviceKey}
              disabled={t.presence !== "online"}
              title={t.presence === "online" ? `${t.name}（${t.account}）` : `${t.name} ${PRESENCE_TAG[t.presence]}：要它开着 Studio、连上团队服务器才能在它上面建任务`}
              onClick={() => pickDevice(t.key)}
              data-testid="remote-draft-device"
            >
              {t.name}
              {t.presence !== "online" && <span className="chip-tag">{PRESENCE_TAG[t.presence]}</span>}
            </button>
          ))}
        </div>
        <label className="pick-row">
          <span className="pick-lab">名称</span>
          <input className="draft-title" value={draft.title} onChange={(e) => update({ title: e.target.value })} placeholder="可不填，用第一句话当名字" aria-label="任务名" maxLength={100} />
        </label>
        {!target ? (
          <span className="drawer-note remote-draft-note" data-testid="remote-draft-state">
            {targets.length ? "上面的设备都不在线：要那台电脑开着 Studio、连上团队服务器才能在它上面建任务。" : "还没有允许了这台电脑的设备。"}
          </span>
        ) : !online ? (
          <span className="drawer-note remote-draft-note" data-testid="remote-draft-state">
            {target.name} {PRESENCE_TAG[target.presence]}：要它开着 Studio、连上团队服务器才能在它上面建任务。
          </span>
        ) : loadError ? (
          <span className="pick-row" data-testid="remote-draft-state">
            <span className="pick-lab" />
            <span className="form-error" role="alert">
              {loadError}
            </span>
            <button type="button" className="btn-ghost small" onClick={() => setAttempt((n) => n + 1)} data-testid="remote-draft-retry">
              重试
            </button>
          </span>
        ) : !catalog ? (
          <span className="drawer-note remote-draft-note" role="status" data-testid="remote-draft-state">
            ◐ 正在从 {target.name} 读取能选的专题、项目和模型…
          </span>
        ) : problem ? (
          <span className="pick-row" data-testid="remote-draft-state">
            <span className="pick-lab" />
            <span className="remote-draft-problem" role="alert">
              ! {problem}
            </span>
          </span>
        ) : (
          <>
            <ChoiceRow label="专题" noun="专题" choices={catalogTopicChoices(catalog)} selected={topicId} onPick={pickTopic} />
            <ChoiceRow
              label="项目"
              noun="项目"
              choices={catalogProjectChoices(catalog, topicId)}
              selected={projectId}
              noneDisabled={noCommon}
              onPick={(id) => {
                pickedByHand.current = true;
                setProjectId(id);
              }}
            />
          </>
        )}
      </div>

      <div
        className={dragging ? "draft-composer dropping" : "draft-composer"}
        onDragOver={(e) => {
          if (attach.onDragOver(e)) setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          setDragging(false);
          attach.onDrop(e);
        }}
      >
        <AttachTray attach={attach} />
        <textarea
          ref={input}
          value={draft.text}
          rows={3}
          aria-label="第一句话"
          placeholder={target ? `比如：把掉落表的说明整理一遍。会作为第一句话发给 ${target.name} 上新开的会话。` : "第一句话"}
          onChange={(e) => update({ text: e.target.value })}
          onPaste={attach.onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          data-testid="remote-draft-text"
        />
        <div className="cbar">
          <button type="button" className="round-btn attach" aria-label="添加图片或文件" title="添加图片或文件（也可以粘贴截图或拖进来）：开始时一起传到那台电脑" onClick={() => picker.current?.click()} data-testid="remote-draft-attach">
            <IconPaperclip />
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            data-testid="remote-draft-attach-input"
            onChange={(e) => {
              attach.addDropped([...(e.currentTarget.files ?? [])]);
              e.currentTarget.value = "";
            }}
          />
          <div className="model-row" role="group" aria-label="模型">
            {(catalog && !problem ? catalog.models : []).map((m) => (
              <button key={m.id} type="button" className="chip" aria-pressed={m.id === profileId} onClick={() => setProfileId(m.id)} data-testid="remote-draft-model">
                {m.label}
              </button>
            ))}
            {catalog && !problem && <span className="drawer-note">只列 {catalog.name} 远端允许的模型</span>}
          </div>
        </div>
        <div className="cbar">
          <span className="drawer-note" data-testid="remote-draft-attach-note">
            图片和文件开始时一起传到那台电脑（每个最多 20 MB，文件夹先打包）；权限照那台电脑「远端允许的模型」里定的。
          </span>
          <span className="spacer" />
          <button type="button" className="btn-primary" onClick={() => void submit()} disabled={busy || !online || !catalog || !!problem} data-testid="remote-draft-start">
            {busy ? (catalog?.confirm ? "正在发送…" : "正在开始…") : catalog?.confirm ? "发给那边确认" : "开始"} <kbd>↵</kbd>
          </button>
        </div>
      </div>

      <div className="foot-hints">
        <span data-testid="remote-draft-how">{catalog?.confirm ? `要 ${catalog.name} 那边同意后才建任务、开跑（它的远程设置 → 安全）；同意后这台电脑的看板上出现远程任务卡` : "任务建在那台电脑上，会话在那边跑；这台电脑的看板上出现远程任务卡"}</span>
        <span className="foot-where" data-testid="scope-hint">
          {where}
        </span>
      </div>
      {notice && (
        <span className="settings-hint remote-draft-notice" role="status" data-testid="remote-draft-waiting">
          ✓ {notice}
        </span>
      )}
      {error && (
        <span className="form-error" role="alert" data-testid="remote-draft-error">
          {error}
        </span>
      )}
      {busy && <StartingCover label={opening ? `正在把 ${opening.name} 上的任务同步过来…` : catalog?.confirm ? `正在发给 ${target?.name ?? "那台电脑"}${attach.empty ? "" : "（连同图片和文件）"}…` : `正在 ${target?.name ?? "那台电脑"} 上建任务、启动会话${attach.empty ? "" : "（先传图片和文件）"}…`} />}
    </>
  );
}
