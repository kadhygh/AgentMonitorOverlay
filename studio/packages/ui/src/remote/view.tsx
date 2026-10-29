import { RemotePage } from "./RemotePage.js";
import { backTo, type ViewDef } from "../shell/views.js";

/** 远程 (2026-10-29): the top bar's 「远程」 opens it; no tab of its own. "←" returns where it was opened from. */
export const remoteView: ViewDef<"remote"> = {
  kind: "remote",
  render: (view, { link, state, setView }) => {
    const back = backTo(view.back);
    return (
      <RemotePage
        link={link}
        tasks={state.tasks}
        profiles={state.profiles}
        workspaces={state.workspaces}
        topics={state.topics}
        backLabel={back.label}
        onBack={() => setView(back.view)}
        // A task opened from here returns here (and from here to where 远程 was opened from).
        onOpenTask={(taskId) => setView({ kind: "task", taskId, nav: Date.now(), back: { kind: "remote", ...(view.back ? { back: view.back } : {}) } })}
        // 远程创建 (2026-10-29): the new-task page in 「在别的设备上」, returning here.
        onNewTaskOn={(peer) => setView({ kind: "new", remote: peer, back: { kind: "remote", ...(view.back ? { back: view.back } : {}) } })}
      />
    );
  },
};
