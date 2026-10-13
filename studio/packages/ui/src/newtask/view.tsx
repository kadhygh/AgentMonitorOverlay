import { NewTaskPage } from "./NewTaskPage.js";
import type { ViewDef } from "../shell/views.js";

/** The draft task page (top bar 新任务, the canvas's 新任务, Ctrl Shift N). */
export const newTaskView: ViewDef<"new"> = {
  kind: "new",
  render: (view, { link, state, scope, setView }) => (
    <NewTaskPage
      link={link}
      workspaces={state.workspaces}
      topics={state.topics}
      tasks={state.tasks}
      profiles={state.profiles}
      scope={view.topicId ? { kind: "topic", id: view.topicId } : scope}
      onBack={() => setView({ kind: "board" })}
      onCreated={(task, session) => setView(session ? { kind: "task", taskId: task.id, sessionId: session.id } : { kind: "board" })}
    />
  ),
};
