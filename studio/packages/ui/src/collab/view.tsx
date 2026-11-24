import { PendingPage } from "./PendingPage.js";
import type { ViewDef } from "../shell/views.js";

/**
 * 待我处理 (2026-11-25, the user 11-24: 留言页换成「待我处理」): a tab after the canvas, with the number of things that
 * wait for the person across every source (GET /api/pending's `mine`: 协作 and this computer).
 */
export const pendingView: ViewDef<"pending"> = {
  kind: "pending",
  tab: { label: "待我处理", open: () => ({ kind: "pending" }), count: (data) => data.pending.mine },
  render: (_view, { link, state, data, setView }) => (
    <PendingPage
      link={link}
      names={{ sessions: state.sessions, tasks: state.tasks, topics: state.topics }}
      snap={data.pending}
      view={data.localPending}
      onOpenTask={(taskId, sessionId) => setView({ kind: "task", taskId, ...(sessionId ? { sessionId } : {}), back: { kind: "pending" } })}
    />
  ),
};
