import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { loadTaskLaunch, type TaskLaunchReceipt } from '../api/taskLaunchClient';
/** A visible receipt observes facts only. No path from mount/show to task execution. */
export function useLaunchReceipt(cardId: string, onReceipt: (value: TaskLaunchReceipt) => void, onError: (value: string) => void) {
    const [nativeVisible, setNativeVisible] = useState(true);
    const [documentVisible, setDocumentVisible] = useState(document.visibilityState !== 'hidden');
    useEffect(() => {
        let disposed = false;
        let visibilityRevision = 0;
        let off: (() => void) | undefined;
        void getCurrentWindow().isVisible().then(value => {
            if (!disposed && visibilityRevision === 0)
                setNativeVisible(value);
        }).catch(() => undefined);
        void listen<boolean>('amo-task-launch-visibility', event => { if (!disposed && typeof event.payload === 'boolean') { visibilityRevision++; setNativeVisible(event.payload); } }).then(fn => {
            if (disposed)
                fn();
            else
                off = fn;
        }).catch(() => undefined);
        const changed = () => setDocumentVisible(document.visibilityState !== 'hidden');
        document.addEventListener('visibilitychange', changed);
        return () => { disposed = true; off?.(); document.removeEventListener('visibilitychange', changed); };
    }, []);
    useEffect(() => {
        if (!cardId || !nativeVisible || !documentVisible)
            return;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const abort = new AbortController();
        async function check() {
            try {
                const result = await loadTaskLaunch(cardId, abort.signal);
                if (!disposed)
                    onReceipt(result.task);
            }
            catch (e) {
                if (!disposed)
                    onError(`无法核对启动：${(e as Error).message}`);
            }
            finally {
                if (!disposed)
                    timer = setTimeout(check, 2500);
            }
        }
        void check();
        return () => { disposed = true; abort.abort(); clearTimeout(timer); };
    }, [cardId, nativeVisible, documentVisible, onReceipt, onError]);
}
