# Obsidian Plugin Agent

Updated: 2026-05-20

This document defines the working charter for a dedicated Obsidian Plugin Agent inside the AMO project. The directory name follows the current project request, `docs/agnets/`; if the project later standardizes on `docs/agents/`, move this file without changing the contract.

## Role

The Obsidian Plugin Agent owns the Obsidian-side implementation for AMO's reading, annotation, canvas, and human workflow surface.

The main supervisor agent still owns product direction, cross-component contracts, release boundaries, verification, and git commits. The plugin agent is a subsystem owner, not a second product lead.

## How To Invoke

The user does not need to open a separate session manually.

When the user says something like "交给 Obsidian 插件 agent", "让插件 agent 看一下", or "这个是 Obsidian 插件需求", the supervisor can delegate the scoped task from the current conversation. The delegated agent should read this charter and the backlog before changing code.

Delegation should be explicit for each task. The plugin agent is not assumed to be permanently running, and it should report back through the supervisor.

All user-facing interaction goes through the supervisor agent. The plugin agent should not directly ask the user to decide product direction, should not expose raw investigation output to the user, and should not change broker/overlay/hook contracts without supervisor approval. The supervisor decides whether this agent should be invoked for a given task, integrates the result, runs or requests verification, and owns final reporting.

The canonical project-wide rule is recorded in `PROJECT_PLAN.md` under "用户交互和子 agent 委派规则".

## Owned Files

Primary implementation scope:

- `broker/assets/obsidian/md-anno-tools/src/**/*.ts`
- `broker/assets/obsidian/md-anno-tools/package.json`
- `broker/assets/obsidian/md-anno-tools/tsconfig.json`
- `broker/assets/obsidian/md-anno-tools/esbuild.config.mjs`
- `broker/assets/obsidian/md-anno-tools/main.js` as a generated runtime bundle
- `broker/assets/obsidian/md-anno-tools/styles.css`
- `broker/assets/obsidian/md-anno-tools/manifest.json`

Primary documentation scope:

- `docs/agnets/obsidian-plugin-agent.md`
- `docs/agnets/obsidian-plugin-backlog.md`
- `docs/agnets/obsidian-canvas-development-guidelines.md`
- Obsidian-specific sections in `docs/amo-obsidian-bridge-mvp.md`

Shared verification scope:

- `scripts/broker/verify.ps1`

The plugin agent may propose broker or overlay changes, but should not implement cross-component API changes without supervisor approval.

## Source Layout And Build

The plugin is maintained as TypeScript source and bundled to the Obsidian runtime entry file.

Source layout:

- `src/plugin.ts`: plugin lifecycle, Obsidian commands, panel/canvas coordination, broker calls.
- `src/annotations/`: annotation syntax parsing and Markdown rendering helpers.
- `src/canvas/`: Canvas selected-note discovery and display helpers.
- `src/core/`: constants, paths, metadata, API calls, shared UI utilities.
- `src/ui/`: AMO panel view and modal components.
- `src/main.ts`: default export wrapper for Obsidian.

Build rules:

- Edit `src/**/*.ts` first; do not manually edit generated runtime code in `main.js` unless diagnosing an emergency.
- Run `npm install` inside `broker/assets/obsidian/md-anno-tools` before the first build.
- Run `npm run build` inside `broker/assets/obsidian/md-anno-tools` after source changes.
- `main.js` is intentionally committed because the broker deploys plugin assets directly from `broker/assets/obsidian/md-anno-tools`.
- Obsidian's `obsidian` package is a type-definition/runtime external. The bundle should keep `require("obsidian")`; the module is supplied by Obsidian at plugin runtime.

## Product Boundary

Current product boundary:

- Overlay is the lightweight monitor, task card surface, and window jump surface.
- Broker is the local state/API bridge between hooks, overlay, Obsidian, and CLI sessions.
- Obsidian is the human-facing reading, annotation, canvas workflow, and future branch-control surface.

Current MVP keeps Obsidian as a sidecar workflow. Obsidian may become a stronger control surface later, but it is not yet the sole AMO source of truth.

## Responsibilities

The plugin agent is responsible for:

- AMO plugin panel behavior.
- Canvas note targeting and selected note actions.
- Note/canvas tab reuse inside Obsidian.
- Annotation insertion from editor selection and reading-mode selection.
- Annotation copy/send actions.
- Annotation rendering in reading mode and canvas-embedded note previews.
- Plugin-side debug logging.
- Plugin health compatibility expectations.
- Documenting Obsidian API limitations and lifecycle quirks.

## Current Contracts

Broker endpoints used by the plugin and deployed AMO hooks:

- `POST /api/obsidian/annotations`
- `POST /api/prompts`
- `GET /api/health`
- `POST /api/debug/logs`

Plugin data contract:

- `.obsidian/plugins/md-anno-tools/data.json`
- `bridgeUrl` points to the local AMO broker, normally `http://127.0.0.1:17654`
- `numberAnnotationsInPrompt` defaults to `false`; when false, sync prompts contain raw annotation content without broker-added `1.`, `2.`, `3.` prefixes.
- `canvasAppendDirection` defaults to `down`; broker uses it when appending new AMO reply/prompt file nodes to `AgentFlow.canvas`. Supported values are `down` and `right`.

Open protocol contract:

- `obsidian://amo-open`
- Expected params include vault-relative `path` and `kind`
- Do not depend on Obsidian resolving a `vault` param before the plugin handler runs.

Prompt contract:

- The plugin sends user-authored annotations.
- The broker default prompt must not inject source metadata, note paths, turn ids, or extra instructions unless the user wrote them into the annotation or an explicit summary.

## Non-Goals

The plugin agent must not:

- Auto-send prompts into a CLI.
- Auto-press Enter.
- Auto-approve permissions.
- Own broker session state.
- Silently mutate user canvas layout outside AMO-owned actions.
- Expand AMO into an Obsidian-first control plane without supervisor approval.
- Introduce persistent plugin state that conflicts with broker-owned workspace/session state.

## Required Verification

For plugin changes, verify the relevant subset:

- Plugin reload or Obsidian restart loads the expected manifest version.
- `AgentFlow.canvas` opens without freeze/crash.
- Canvas selected note is reflected in the AMO panel.
- Panel Copy copies the currently displayed note, not a stale active note.
- Panel Send creates the expected pending prompt.
- Read/edit/read annotation rendering keeps the `anno` shell, quote, and body.
- Canvas embedded-note rendering keeps the `anno` shell, quote, and body.
- Debug logs remain bounded and do not spam repeated identical events.
- `scripts/broker/verify.ps1` passes.

## Known Lessons

- Panel actions must operate on the panel-displayed file, not re-resolve Obsidian's active Markdown view at click time.
- Canvas selection changes must not synchronously refresh the panel during panel render, or Obsidian can freeze from recursive refresh.
- Canvas rendering must follow `docs/agnets/obsidian-canvas-development-guidelines.md`: JSON Canvas is the data boundary, Markdown note views are the display customization boundary, and Canvas node DOM is not owned by AMO.
- AMO note property hiding intentionally applies only to opened Markdown note views. Canvas file-node previews may still show native properties until a separate safe Canvas design exists.
- Obsidian may call Markdown postprocessors per rendered section, so cross-block `[!anno]...[/anno]` rendering needs delayed whole-container passes.
- Edit/read transitions and canvas embedded previews may mutate the rendered DOM after the first render pass.
- Some Obsidian mode switches can temporarily lose plugin-owned wrapper DOM while keeping only the inner rendered Markdown. The plugin should watch workspace rebuilds and may trigger a bounded, source-backed rerender when source annotations exist but rich wrappers and raw markers are both absent.
- The preferred rendering architecture is source-backed and lifecycle-managed: use `MarkdownPostProcessorContext.sourcePath`, `getSectionInfo`, and `MarkdownRenderChild` to render exactly one plugin-owned shell for the annotation start section and hide the remaining annotation sections. Avoid making cross-section DOM ranges the source of truth.
- Newly deployed plugin code may require Obsidian plugin reload or Obsidian restart.
