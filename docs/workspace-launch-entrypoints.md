# Workspace launch entrypoints

Workspace Center and a task card's project quick-launch dialog share the new-task launch implementation.

- `overlay/src/components/WorkspaceLaunchForm.tsx` owns client, launch-mode, route, and model selection, credential status, optional one-launch key input, and launch feedback.
- `overlay/src/domain/workspaceLaunchRoutes.ts` groups the existing provider presets for both entrypoints. Grouping does not change stored preset IDs or resume metadata.
- `overlay/src/api/workspaceLaunch.ts` owns launch validation, resolving the active provider's saved credential, terminal preferences, the request to `/api/workspaces/launch`, ChatGPT URI opening, and remembering a successful ordinary-CLI directory.
- `broker/lib/workspace-launch.js` remains the common backend for terminal launch and managed launch records.

`DeployWorkspaceApp` and `useWorkspacePanels` provide workspace context and handle their own navigation, busy state, and feedback. They must call `launchWorkspaceTool()` instead of constructing broker launch payloads or resolving launch credentials independently. `LaunchPanel` only supplies a dialog and source-task context around the shared form.

For matching settings and a managed launch, the card entrypoint adds only `sourceCardSessionId`. Ordinary CLI launches do not create a managed source-card association. Resuming an existing task continues to use the separate session-resume workflow.

Tests in `overlay/tests/runtime/workspaceLaunch.test.mjs` compare the center and card launch payloads and cover credential isolation, overrides, default accounts, managed validation, ordinary CLI launches, failure propagation, and ChatGPT opening. The Vite-only fixture at `overlay/tests/manual/workspace-center.html` exercises both real UI entrypoints using simulated native and broker operations. It is not a production entrypoint.
