import type { TaskLaunchRequest } from '../api/taskLaunchClient';
import { isCodexProviderPresetId } from '../native/modelProviders';
export const launcherStorageKey = 'amo.taskLaunch.v1';
export interface CopyPreferences {
    presetId: string;
    reasoningEffort: string;
    groupId: string;
    afterLaunch: 'cli' | 'amo';
    remember: boolean;
    reserved: boolean;
}
export function loadLauncherState(): Record<string, unknown> {
    try {
        const value = JSON.parse(localStorage.getItem(launcherStorageKey) || '{}');
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    catch {
        return {};
    }
}
export function saveLauncherState(value: unknown) {
    try {
        localStorage.setItem(launcherStorageKey, JSON.stringify(value));
        return true;
    }
    catch {
        return false; /* Draft remains in memory; execution must stop without durable identity. */
    }
}
export function receiptLabel(state: string) { return ({ launching: '正在启动窗口', waiting_session: '等待 Session 接入', connected: '真实 Session 已接入', unknown: '启动结果待核对', failed: '启动失败', failed_retryable: '终端未启动，可安全重试', archived: '会话已归档' } as Record<string, string>)[state] || '状态待核对'; }
/** Only persist launch data; credentials are never accepted from restored state. */
export function cleanPending(value: unknown): TaskLaunchRequest | null {
    if (!value || typeof value !== 'object')
        return null;
    const v = value as Partial<TaskLaunchRequest>;
    if (typeof v.operationId !== 'string' || !v.operationId || typeof v.workspacePath !== 'string' || typeof v.groupId !== 'string' || typeof v.prompt !== 'string' || !v.codexProvider || !isCodexProviderPresetId(v.codexProvider.presetId) || !['medium', 'high', 'xhigh'].includes(v.reasoningEffort || '') || !['windows-powershell', 'powershell7', 'alacritty-powershell7'].includes(v.launchEnvironment || '') || !['cli', 'amo'].includes(v.afterLaunch || ''))
        return null;
    return { operationId: v.operationId, workspacePath: v.workspacePath, groupId: v.groupId, title: typeof v.title === 'string' ? v.title : undefined, prompt: v.prompt, codexProvider: { presetId: v.codexProvider.presetId }, reasoningEffort: v.reasoningEffort!, launchEnvironment: v.launchEnvironment!, afterLaunch: v.afterLaunch! };
}
