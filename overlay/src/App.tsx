import { DeployWorkspaceApp } from "./windows/DeployWorkspaceApp";
import { MainOverlayApp } from "./windows/MainOverlayApp";
import { ScratchpadApp } from "./windows/ScratchpadApp";
import { SettingsWindowApp } from "./windows/SettingsWindowApp";
import { CURRENT_WINDOW_LABEL } from "./windows/utilityWindow";

export default function App() {
  if (CURRENT_WINDOW_LABEL === "scratchpad") {
    return <ScratchpadApp />;
  }

  if (CURRENT_WINDOW_LABEL === "deploy") {
    return <DeployWorkspaceApp />;
  }

  if (CURRENT_WINDOW_LABEL === "settings") {
    return <SettingsWindowApp />;
  }

  return <MainOverlayApp />;
}
