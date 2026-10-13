import { workspacesActivity } from "@amo-studio/protocol";
import { ProposalsPanel } from "./ProposalsPanel.js";
import type { BoardPanel } from "../shell/views.js";

/** Above the board: the scheduler's proposals waiting for the person, and starting a round. */
export const proposalsPanel: BoardPanel = {
  feature: "planning",
  render: ({ link, state, data, setView }) => (
    <ProposalsPanel
      link={link}
      proposals={data.proposals}
      todos={data.todos}
      workspaces={state.workspaces}
      profiles={state.profiles}
      activity={workspacesActivity(state.workspaces, state.sessions)}
      onStarted={(taskId, sessionId) => setView({ kind: "task", taskId, sessionId })}
    />
  ),
};
