import { lazy, Suspense, type ComponentType } from "react";
import { MainOverlayApp } from "./windows/MainOverlayApp";
import { CURRENT_WINDOW_LABEL } from "./windows/utilityWindow";

const utilityApps: Record<string, React.LazyExoticComponent<ComponentType>> = {
  deploy: lazy(() => import("./windows/DeployWorkspaceApp").then((module) => ({ default: module.DeployWorkspaceApp }))),
  priorities: lazy(() => import("./windows/PriorityManagerApp").then((module) => ({ default: module.PriorityManagerApp }))),
  scratchpad: lazy(() => import("./windows/ScratchpadApp").then((module) => ({ default: module.ScratchpadApp }))),
  settings: lazy(() => import("./windows/SettingsWindowApp").then((module) => ({ default: module.SettingsWindowApp }))),
};

function UtilityWindowLoading() {
  return (
    <main className="amo-boot" role="status" aria-live="polite">
      <div className="amo-boot-content">
        <span className="amo-boot-mode">AMO</span>
        <div className="amo-boot-mark" aria-hidden="true" />
        <strong>Opening tool</strong>
        <span className="amo-boot-stage">Loading window interface</span>
      </div>
    </main>
  );
}

export default function App() {
  if (CURRENT_WINDOW_LABEL === "main") {
    return <MainOverlayApp />;
  }

  const UtilityApp = utilityApps[CURRENT_WINDOW_LABEL];
  if (!UtilityApp) {
    return <MainOverlayApp />;
  }

  return (
    <Suspense fallback={<UtilityWindowLoading />}>
      <UtilityApp />
    </Suspense>
  );
}