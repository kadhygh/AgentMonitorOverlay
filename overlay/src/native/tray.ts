import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const TRAY_OPEN_REQUESTED_EVENT = "tray-open-requested";

export interface TrayOpenRequest {
  expand: boolean;
  selectAttentionFilter: boolean;
}

export function setTrayAttentionState(attention: boolean) {
  return invoke<void>("set_tray_attention_state", { attention });
}

export function listenForTrayOpenRequests(
  listener: (request: TrayOpenRequest) => void,
): Promise<UnlistenFn> {
  return listen<TrayOpenRequest>(TRAY_OPEN_REQUESTED_EVENT, ({ payload }) => {
    listener(payload);
  });
}
