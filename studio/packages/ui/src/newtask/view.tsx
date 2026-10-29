import { NewTaskPage } from "./NewTaskPage.js";
import { backTo, type ViewDef } from "../shell/views.js";

/** The draft task page (top bar 新任务, the canvas's 新任务, Ctrl Shift N). "←" returns where it was opened from. */
export const newTaskView: ViewDef<"new"> = {
  kind: "new",
  render: (view, { link, state, scope, setView }) => {
    const back = backTo(view.back);
    return (
      <NewTaskPage
        link={link}
        workspaces={state.workspaces}
        topics={state.topics}
        tasks={state.tasks}
        sessions={state.sessions}
        profiles={state.profiles}
        scope={view.topicId ? { kind: "topic", id: view.topicId } : scope}
        {...(view.back?.kind === "canvas" && view.topicId ? { canvasTopicId: view.topicId } : {})}
        backLabel={back.label}
        onBack={() => setView(back.view)}
        // The task page returns to the same place; a task only filed goes back there right away.
        onCreated={(task, session) => setView(session ? { kind: "task", taskId: task.id, sessionId: session.id, created: true, ...(view.back ? { back: view.back } : {}) } : back.view)}
        // 远程创建 (2026-10-29): the device card's 「在它上面新建任务」 picks the device; the copy opens once it is here.
        {...(view.remote ? { remoteDevice: view.remote } : {})}
        onOpenRemote={(taskId, sessionId) => setView({ kind: "task", taskId, ...(sessionId ? { sessionId } : {}), created: true, ...(view.back ? { back: view.back } : {}) })}
      />
    );
  },
};
