import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { LogicalSize } from '@tauri-apps/api/dpi';
import { closeUtilityWindow, useUtilityWindowLifecycle } from './utilityWindow';
import { useLaunchReceipt } from '../task-launch/useLaunchReceipt';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Orbit, SlidersHorizontal, ArrowUpRight, RefreshCw, X, GitBranch, Folder, ChevronDown, Sparkles, Focus, Check, SquareTerminal, ArrowRight } from 'lucide-react';
import { useAmoThemeRuntime } from '../theme/amoTheme';
import { workspaceLaunchRoutes, workspaceLaunchModelLabel } from '../domain/workspaceLaunchRoutes';
import { loadDefaultCodexProvider, isCodexProviderPresetId, modelCredentialProviderId, resolveModelCredential } from '../native/modelProviders';
import { cliLaunchPreferencePayload } from '../native/cliLaunch';
import { createTaskLaunch, retryTaskLaunch, loadTaskLaunchContext, TaskLaunchError, type TaskLaunchRequest, type TaskLaunchReceipt, type TaskLaunchContext } from '../api/taskLaunchClient';
import { loadLauncherState, saveLauncherState, cleanPending, receiptLabel, type CopyPreferences } from '../task-launch/state';
import '../task-launch/task-launch.css';
const initial = loadLauncherState();
const defaultPrefs = (): CopyPreferences => ({ presetId: loadDefaultCodexProvider(), reasoningEffort: 'medium', groupId: '', afterLaunch: 'cli', remember: true, reserved: false });
export function TaskLaunchApp() {
    useAmoThemeRuntime();
    useUtilityWindowLifecycle('task-launch');
    const [context, setContext] = useState<TaskLaunchContext>({ workspaces: [], groups: [], reviewGroupId: null });
    const [path, setPath] = useState(typeof initial.path === 'string' ? initial.path : '');
    const [prompt, setPrompt] = useState(typeof initial.prompt === 'string' ? initial.prompt : '');
    const [title, setTitle] = useState(typeof initial.title === 'string' ? initial.title : '');
    const [prefs, setPrefs] = useState<CopyPreferences>({ ...defaultPrefs(), ...(initial.prefs as Partial<CopyPreferences> || {}) });
    const copies = useRef<Record<string, CopyPreferences>>((initial.copies as Record<string, CopyPreferences>) || {});
    const [notice, setNotice] = useState('');
    const retryOperation = useRef(typeof initial.retryOperation === 'string' ? initial.retryOperation : '');
    const [expanded, setExpanded] = useState(false), [menu, setMenu] = useState(false), [approved, setApproved] = useState(false);
    const [receipt, setReceipt] = useState<TaskLaunchReceipt | null>(null), [cardId, setCardId] = useState(typeof initial.cardId === 'string' ? initial.cardId : '');
    const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [apiKey, setApiKey] = useState('');
    const [pending, setPending] = useState<TaskLaunchRequest | null>(cleanPending(initial.pending));
    const commandId = useRef('');
    const commandTimer = useRef<ReturnType<typeof setTimeout>>();
    const lock = useRef(false);
    const routes = workspaceLaunchRoutes('codex-cli');
    const modelAvailable = routes.some(route => route.models.some(model => model.id === prefs.presetId));
    const workspace = context.workspaces.find(w => w.workspacePath === path);
    const currentGroup = context.groups.find(g => g.groupId === prefs.groupId);
    const credentialId = modelCredentialProviderId(prefs.presetId);
    async function refresh() {
        setLoading(true);
        try {
            const next = await loadTaskLaunchContext();
            setContext(next);
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            setLoading(false);
        }
    }
    useEffect(() => {
        let stop: (() => void) | undefined;
        let disposed = false;
        void listen<{
            requestId: string;
            ok: boolean;
            message?: string;
        }>('task-launch-command-result', e => {
            if (!disposed && e.payload.requestId === commandId.current) {
                clearTimeout(commandTimer.current);
                setError(e.payload.ok ? '' : e.payload.message || '无法打开对应 CLI');
                setNotice(e.payload.ok ? '已交给 AMO，请核对对应窗口。' : '');
            }
        }).then(fn => { if (disposed)
            fn();
        else
            stop = fn; }).catch(() => undefined);
        return () => { disposed = true; stop?.(); clearTimeout(commandTimer.current); };
    }, []);
    useEffect(() => { void refresh(); window.addEventListener('focus', refresh); return () => window.removeEventListener('focus', refresh); }, []);
    useEffect(() => {
        if (prefs.remember && path)
            copies.current[path] = prefs;
        saveLauncherState({ path, prompt, title, prefs, copies: copies.current, cardId, retryOperation: retryOperation.current, pending: pending ? { ...pending, codexProvider: { presetId: pending.codexProvider.presetId } } : null });
    }, [path, prompt, title, prefs, cardId, pending]);
    const receiptError = useCallback((message: string) => setError(message), []);
    useLaunchReceipt(busy ? "" : cardId, setReceipt, receiptError);
    const blocked = busy || !!receipt || !!pending || !!cardId;
    async function mainEvent(name: string, payload?: unknown) {
        if (name === 'task-launch-open-session') {
            commandId.current = crypto.randomUUID();
            setNotice('正在请求 AMO 打开对应窗口…');
            clearTimeout(commandTimer.current);
            commandTimer.current = setTimeout(() => setNotice('AMO 尚未返回窗口操作结果，请核对窗口后再尝试。'), 10000);
            payload = { ...(payload as object), requestId: commandId.current };
        }
        try {
            await getCurrentWindow().emitTo('main', name, payload);
        }
        catch (e) {
            setError((e as Error).message);
        }
    }
    function choose(next: string) {
        if (blocked) return;
        if (prefs.remember && path)
            copies.current[path] = prefs;
        setPath(next);
        setPrefs(copies.current[next] || defaultPrefs());
        setApproved(false);
        setApiKey('');
        setMenu(false);
    }
    async function run(replay = false) {
        if (lock.current || (!replay && blocked))
            return;
        if (!replay && (!workspace?.enrolled || workspace.unavailableReason || !currentGroup || !isCodexProviderPresetId(prefs.presetId)))
            return;
        if (!replay && prefs.reserved && !approved) {
            setError('这是应急预留副本，请先确认本次使用。');
            return;
        }
        lock.current = true;
        setBusy(true);
        setError('');
        let request = pending;
        try {
            if (!request) {
                request = { operationId: crypto.randomUUID(), workspacePath: path, groupId: prefs.groupId, title: title.trim() || undefined, prompt, codexProvider: { presetId: prefs.presetId as TaskLaunchRequest['codexProvider']['presetId'] }, reasoningEffort: prefs.reasoningEffort, ...cliLaunchPreferencePayload(), afterLaunch: prefs.afterLaunch };
            }
            const keyProvider = modelCredentialProviderId(request.codexProvider.presetId);
            const key = keyProvider ? (apiKey.trim() || await resolveModelCredential(keyProvider)) : undefined;
            if (keyProvider && !key)
                throw new Error('缺少 API Key，请输入本次 Key，或在原有凭据设置中保存。');
            if (!saveLauncherState({ path, prompt, title, prefs, copies: copies.current, cardId, pending: cleanPending(request) })) {
                throw new Error('无法保存启动身份，请恢复本地存储后再启动。尚未发送请求。');
            }
            setPending(request);
            const result = await createTaskLaunch({ ...request, codexProvider: { ...request.codexProvider, ...(key ? { apiKey: key } : {}) } });
            setReceipt(result.task);
            setCardId(result.task.cardId);
            setPending(null);
            setApiKey('');
            if (request.afterLaunch === 'amo')
                void getCurrentWindow().setFocus().catch(() => undefined);
        }
        catch (e) {
            if (e instanceof TaskLaunchError && e.status >= 400 && e.status < 500 && e.status !== 408 && (e.status !== 409 || e.code === "task_launch_group_unavailable")) {
                setPending(null);
            }
            setError((e as Error).message);
        }
        finally {
            lock.current = false;
            setBusy(false);
        }
    }
    async function retry() {
        if (lock.current || !receipt)
            return;
        lock.current = true;
        setBusy(true);
        setError('');
        try {
            const provider = modelCredentialProviderId(prefs.presetId);
            const key = provider ? (apiKey.trim() || await resolveModelCredential(provider)) : undefined;
            if (provider && !key)
                throw new Error('请补充本次启动的 API Key。');
            const operationId = retryOperation.current || crypto.randomUUID();
            retryOperation.current = operationId;
            if (!saveLauncherState({ path, prompt, title, prefs, copies: copies.current, cardId, retryOperation: operationId }))
                throw new Error('无法保存重试身份，尚未发送请求。');
            const result = await retryTaskLaunch(cardId, { operationId, ...(key ? { apiKey: key } : {}) });
            setReceipt(result.task);
            retryOperation.current = '';
            setApiKey('');
            if (result.task.afterLaunch === 'amo') void getCurrentWindow().setFocus().catch(() => undefined);
        }
        catch (e) {
            setError((e as Error).message);
        }
        finally {
            lock.current = false;
            setBusy(false);
        }
    }
    function reset() { retryOperation.current = ''; setReceipt(null); setCardId(''); setPrompt(''); setTitle(''); setApproved(false); setError(''); setNotice(''); }
    return <main className="task-launch" onKeyDown={e => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                void run();
            }
        }}>
 <section className={`tl-window${expanded ? ' expanded' : ''}`}>
 <header className="tl-chrome" onPointerDown={e => {
            if (!(e.target as HTMLElement).closest('button'))
                void getCurrentWindow().startDragging().catch(() => undefined);
        }}>
    <div className="tl-brand">
    <span className="tl-brand-mark"><Orbit size={18}/></span>
    <div><h1>新任务</h1><span className="tl-brand-caption">AMO · Codex CLI</span></div>
    </div>
    <div className="tl-actions">
    <button className="tl-settings-toggle" onClick={() => { setExpanded(!expanded); void getCurrentWindow().setSize(new LogicalSize(Math.min(expanded ? 610 : 820, screen.availWidth), Math.min(expanded ? 480 : 650, screen.availHeight))).catch(() => undefined); }} aria-expanded={expanded}>
    <SlidersHorizontal size={16}/>{expanded ? '收起设置' : '展开设置'}
    </button>
    <button className="tl-close" aria-label="隐藏启动入口" onClick={() => void closeUtilityWindow('task-launch')}>
    <X size={17}/>
    </button>
    </div>
    </header>
 <div className="tl-context">
    <button className="tl-workspace-trigger" disabled={blocked} onClick={() => setMenu(!menu)} aria-expanded={menu}><Folder size={15}/><span>{workspace?.label || '选择工程副本'}</span><ChevronDown size={13}/></button>{workspace && <span className="tl-branch">
        <GitBranch size={13}/>{workspace.branch || '分支未确认'}
        </span>}<button aria-label="刷新工程和分组" disabled={loading || busy} onClick={() => void refresh()}>
    <RefreshCw size={14}/>
    </button>
    </div>
 {menu && <div className="tl-workspaces">{context.workspaces.map(w => <button disabled={blocked} key={w.workspacePath} aria-pressed={path === w.workspacePath} onClick={() => choose(w.workspacePath)}>
            <div className="tl-workspace-option-title"><Folder size={15}/><strong>{w.label}</strong>{path === w.workspacePath && <Check size={14}/>}</div>
            <small>{w.branch || '分支未确认'} · {w.workspacePath}
            </small>
            <small>{w.unavailableReason || (!w.enrolled ? '尚未接入 AMO' : '已接入 AMO')}
            </small>
            </button>)}<button onClick={() => void mainEvent('task-launch-open-workspaces')}>管理工程副本 →</button>
        </div>}
 {(!context.workspaces.length || workspace && !workspace.enrolled || workspace?.unavailableReason) && !loading && <div className="tl-notice">{workspace?.unavailableReason || '请选择已完成 Codex 接入的工程副本。'}<button onClick={() => void mainEvent('task-launch-open-workspaces')}>前往工作区接入 →</button>
        </div>}
 <div className="tl-editor">
    <div className="tl-compose">
    <div className="tl-prompt-area"><div className="tl-prompt-heading"><span>{receipt || cardId ? '本次任务' : '想推进什么？'}</span><small>{prompt.length > 0 ? `${prompt.length.toLocaleString()} / 8,000` : '首问可留空'}</small></div>
    <textarea aria-label="首个问题" maxLength={8000} value={prompt} disabled={blocked} onChange={e => setPrompt(e.target.value)} placeholder={'描述一个问题、想法，或下一步…'}/>
    {expanded && <div className="tl-location"><Folder size={12}/><p className="tl-path">{path || '尚未选择工程副本'}</p></div>}
    </div>
 {expanded && <aside className="tl-options">
        <div className="tl-options-heading"><SlidersHorizontal size={14}/><h2>启动设置</h2></div>
        <label>任务标题 · 可选<input maxLength={100} value={title} disabled={blocked} onChange={e => setTitle(e.target.value)} placeholder="默认取首问第一行"/>
        </label>
        <label>思考强度<select disabled={blocked} value={prefs.reasoningEffort} onChange={e => setPrefs({ ...prefs, reasoningEffort: e.target.value })}>{['medium', 'high', 'xhigh'].map(x => <option key={x} value={x}>{{medium:'Medium · 均衡',high:'High · 深入',xhigh:'Extra high · 更深入'}[x]}
            </option>)}
        </select>
        </label>
        <label>加入 Focus 分组<select disabled={blocked} value={prefs.groupId} onChange={e => setPrefs({ ...prefs, groupId: e.target.value })}>
        <option value="">选择已有分组</option>{context.groups.map(g => <option key={g.groupId} value={g.groupId}>{g.name}
            </option>)}
        </select>
        </label>
        <label>启动后<select disabled={blocked} value={prefs.afterLaunch} onChange={e => setPrefs({ ...prefs, afterLaunch: e.target.value as 'cli' | 'amo' })}>
        <option value="cli">转到新 CLI 窗口</option>
        <option value="amo">留在 AMO，继续创建</option>
        </select>
        </label>
        <label className="tl-check">
        <input type="checkbox" disabled={blocked} checked={prefs.remember} onChange={e => setPrefs({ ...prefs, remember: e.target.checked })}/>记住此副本的启动设置</label>
        <label className="tl-check">
        <input type="checkbox" disabled={blocked} checked={prefs.reserved} onChange={e => { setPrefs({ ...prefs, reserved: e.target.checked }); setApproved(false); }}/>将此副本标为应急预留</label>
        </aside>}
 </div>
 {prefs.reserved && <div className="tl-notice">
        <label className="tl-check">
        <input type="checkbox" checked={approved} disabled={blocked} onChange={e => setApproved(e.target.checked)}/>本次使用应急预留副本</label>
        </div>}
 <div className="tl-bottom">
    <div className="tl-model-picker"><Sparkles size={15}/>
    <select aria-label="启动模型" disabled={blocked} value={prefs.presetId} onChange={e => { setPrefs({ ...prefs, presetId: e.target.value }); setApiKey(''); }}>{routes.map(r => <optgroup key={r.id} label={r.title}>{r.models.map(m => <option key={m.id} value={m.id}>{m.optionLabel || workspaceLaunchModelLabel(m.model)}
            </option>)}
        </optgroup>)}
    </select>
    </div>
    <button className="tl-run" disabled={blocked || loading || !modelAvailable || !workspace?.enrolled || !!workspace.unavailableReason || !currentGroup || (prefs.reserved && !approved)} onClick={() => void run()}>{busy ? '正在启动…' : receipt || cardId ? '已建立任务' : prompt.trim() ? 'Run' : '打开 CLI'}<ArrowUpRight size={16}/>
    </button>
    </div>
 {!modelAvailable && <p className="tl-error">之前选择的模型已不可用，请重新选择模型。</p>}
 {credentialId && <details className="tl-key">
        <summary>凭据 · 使用已保存配置</summary>
        <label>本次使用其他 Key<input aria-label="本次 API Key" autoComplete="off" type="password" disabled={busy || !!receipt && receipt.state !== 'failed_retryable'} value={apiKey} onChange={e => setApiKey(e.target.value)}/></label>
        </details>}
 <div className="tl-hint">
    <button disabled={blocked} onClick={() => setExpanded(true)}><Focus size={13}/>{currentGroup ? `自动加入 Focus · ${currentGroup.name}` : '请选择 Focus 分组'}
    </button>
    <small><kbd>Ctrl</kbd><span>+</span><kbd>Enter</kbd></small>
    </div>
 {!context.groups.length && !loading && <div className="tl-notice">还没有 Focus 分组。<button onClick={() => void mainEvent('task-launch-open-focus')}>创建分组 →</button>
        </div>}
 {notice && <p role="status">{notice}
        </p>}{error && <p className="tl-error" role="alert">{error}
        </p>}{pending && <div className="tl-notice">这次启动结果尚未确认，不会自动重复发送首问。<button disabled={busy} onClick={() => void run(true)}>核对同一次启动</button>
        </div>}
 </div>
 {(receipt || cardId) && <div className="tl-receipt" aria-live="polite">
        <div className="tl-receipt-heading"><span className={`tl-receipt-mark ${receipt?.state === 'connected' ? 'is-connected' : ''}`}>{receipt?.state === 'connected' ? <Check size={16}/> : <SquareTerminal size={16}/>}</span><div><strong>{receipt ? receiptLabel(receipt.state) : '正在恢复启动记录…'}</strong><p>{receipt?.title}</p></div></div>
        <div className="tl-progress" aria-label="启动进度"><span className="is-done"><i/>工作卡已建立</span><ArrowRight size={12}/><span className={receipt?.state === 'connected' || receipt?.state === 'waiting_session' ? 'is-done' : ''}><i/>窗口已启动</span><ArrowRight size={12}/><span className={receipt?.sessionId ? 'is-done' : ''}><i/>会话已接入</span></div>
        {(receipt?.state === 'failed_retryable' || receipt?.state === 'unknown' || receipt?.state === 'archived') && <p className="tl-receipt-message">{receipt.state === 'archived' ? '这张卡片或会话已归档，不会再次启动。' : receipt.state === 'unknown' ? '暂时无法确认启动结果。请先查看已有终端，这次请求不会自动重发。' : receipt.message?.includes('Windows limit') ? '首问编码超出 Windows 命令长度限制，尚未打开终端。请缩短首问后建立新任务。' : '确认终端尚未启动，首问与工作卡已保留，可以重试同一任务。'}</p>}
        {receipt && <small className="tl-receipt-note">{receipt.promptState === 'empty' ? '未发送首问，可在 CLI 中开始讨论。' : receipt.promptState === 'observed' ? '已观察到首问接入。' : '首问执行尚未确认，不会自动重复发送。'}</small>}
        <div className="tl-actions">{receipt?.state === 'failed_retryable' && <button disabled={busy} onClick={() => void retry()}>重试同一任务</button>}{receipt?.sessionId && receipt.state !== 'archived' && <button className="tl-open-cli" onClick={() => void mainEvent('task-launch-open-session', { cardId })}><SquareTerminal size={14}/>打开对应 CLI<ArrowUpRight size={13}/></button>}<button onClick={() => void mainEvent('task-launch-open-focus')}><Focus size={14}/>查看 Focus</button><button className="tl-next-task" disabled={busy || receipt?.state === 'launching'} onClick={reset}>再建一个任务<ArrowRight size={13}/></button></div>
        {receipt && !receipt.sessionId && receipt.state === 'waiting_session' && <small>正在等待接入信息；现有终端不会被再次启动。</small>}
        </div>}
 </section>
    </main>;
}
