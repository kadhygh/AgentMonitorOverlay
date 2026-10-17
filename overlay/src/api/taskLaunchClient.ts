import type { CodexProviderLaunchConfig } from '../native/modelProviders';
import type { CliLaunchEnvironment } from '../native/cliLaunch';
export interface LaunchWorkspace {
    workspaceId: string;
    workspacePath: string;
    label: string;
    branch: string | null;
    enrolled: boolean;
    unavailableReason?: string | null;
}
export interface TaskLaunchContext {
    workspaces: LaunchWorkspace[];
    groups: {
        groupId: string;
        name: string;
    }[];
    reviewGroupId: string | null;
}
export interface TaskLaunchRequest {
    operationId: string;
    workspacePath: string;
    groupId: string;
    title?: string;
    prompt: string;
    codexProvider: CodexProviderLaunchConfig;
    reasoningEffort: string;
    launchEnvironment: CliLaunchEnvironment;
    afterLaunch: 'cli' | 'amo';
}
export interface TaskLaunchReceipt {
    cardId: string;
    launchId: string;
    state: 'launching' | 'waiting_session' | 'connected' | 'unknown' | 'failed' | 'failed_retryable' | 'archived';
    workspacePath: string;
    title: string;
    sessionId: string | null;
    promptState: 'empty' | 'unconfirmed' | 'observed';
    afterLaunch: 'cli' | 'amo';
    message?: string;
}
export class TaskLaunchError extends Error {
    constructor(message: string, public status: number, public code?: string) { super(message); }
}
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const response = await fetch(`http://127.0.0.1:17654/api/${path}`, { signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal, ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
        const result = await response.json();
        if (!response.ok || result.ok === false)
            throw new TaskLaunchError(result.message || result.error || '请求失败', response.status, result.code || result.error);
        return result;
    }
    finally {
        clearTimeout(timer);
    }
}
export const loadTaskLaunchContext = () => request<TaskLaunchContext>('task-launch-context');
export const createTaskLaunch = (body: TaskLaunchRequest) => request<{
    task: TaskLaunchReceipt;
}>('task-launches', body);
export const loadTaskLaunch = (cardId: string, signal?: AbortSignal) => request<{
    task: TaskLaunchReceipt;
}>(`task-launches/${encodeURIComponent(cardId)}`, undefined, signal);
export const retryTaskLaunch = (cardId: string, body: {
    operationId: string;
    apiKey?: string;
}) => request<{
    task: TaskLaunchReceipt;
}>(`task-launches/${encodeURIComponent(cardId)}/retry`, body);
