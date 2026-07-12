# Getting Started

This guide takes a clean Windows machine from an extracted AMO Portable build to the first reviewed CLI reply.

## Before You Start

Required:

- Windows 10 or Windows 11, x64;
- WebView2 Runtime;
- a writable project folder;
- at least one supported CLI already installed and available in PowerShell: `codex` or `claude`.

Optional but recommended:

- Windows Terminal for managed CLI windows;
- Obsidian for reply notes, annotations, and canvases;
- Codex App when a task should target the desktop app instead of a CLI window.

Normal Portable users do not need Node.js, npm, Rust, or a source checkout. AMO carries the Broker and its pinned Node runtime in the release folder.

## 1. Start AMO

Download the latest Portable ZIP from GitHub Releases, extract the entire folder, and run `AMO.exe`.

Do not run the executable directly from inside the ZIP. Keep `AMO.exe`, `runtime/`, and `data/` together.

AMO starts its local Broker before loading the task-card UI. A brief readiness state is normal. A persistent `127.0.0.1 refused to connect` page means the Broker did not become ready; exit AMO and inspect the diagnostic log before retrying.

<!-- SCREENSHOT TODO: Clean first launch.
Show the empty AMO window, broker-live text, tray icon, and no task cards.
Capture both dark and light themes if convenient; the README needs only one. -->

## 2. Enroll A Workspace

Open **Workspace Center** from the folder icon.

1. Choose or paste the project path.
2. Select **Check** to inspect the folder.
3. Review the adapter status instead of assuming an empty folder is already deployed.
4. Select the required adapters.
5. Select **Deploy Selected**.

Deployment is script-driven. It writes project-local adapter files and creates the project's `.amo` folder; no LLM participates in this operation.

The Git exclude action can keep AMO-local artifacts out of commits. Treat `.claude/settings.local.json` separately: include it only when the project should keep that machine-local Claude configuration out of Git.

<!-- SCREENSHOT TODO: Workspace Center deployment sequence, preferably as two images.
A: folder checked but not deployed. B: deployment complete with adapter versions and launch actions.
Use a disposable repository and ensure the Git root/path contains no personal name. -->

## 3. Load The AMO Vault In Obsidian

AMO creates an Obsidian vault inside the project:

```text
<project>/.amo/obsidian-vault/
```

Obsidian must load that folder as a vault once before `obsidian://` links can reliably address it.

1. In Obsidian, choose **Open folder as vault**.
2. Select `<project>/.amo/obsidian-vault`.
3. Confirm the AMO plugin is present and enabled.
4. Return to AMO and retry Note or Canvas.

If the vault has never been loaded, AMO shows a recovery dialog that can open the folder in Explorer or copy its path. Opening the folder in Explorer is not the same as loading it as an Obsidian vault.

<!-- GIF TODO: First Obsidian vault registration.
Start at AMO's recovery dialog, copy/open the vault path, load it in Obsidian,
then click the same Note button successfully. Keep the clip under 20 seconds. -->

## 4. Launch A Managed CLI

Use a launch action from Workspace Center or a task card. AMO injects a launch identity and records the managed window so later hooks can claim the correct task card.

A CLI started manually can still produce hook cards, but AMO may require an explicit window choice or drag-to-bind action because the hook alone cannot always identify a Windows Terminal tab or pane.

Start one conversation and wait for its reply hook. The card should move through the running lifecycle and end in Review when a reply is ready.

<!-- GIF TODO: Managed CLI lifecycle.
Launch Codex CLI from AMO, enter a short disposable prompt, show Running,
then show the same card entering Review. Include the terminal title token but hide session IDs. -->

## 5. Review And Return

Select **Note** on the Review card. In Obsidian:

1. select a sentence that needs a response;
2. add a quoted annotation from the AMO panel or configured command;
3. write the instruction beneath the quoted source;
4. review the annotation list;
5. return the collected content to the corresponding CLI or app.

Opening Note, Canvas, App, CLI, or marking the card Seen clears the current review attention state. A later hook can wake an archived task again.

<!-- GIF TODO: The primary AMO workflow.
Select two lines in a reply note, create an annotation, type one short response,
return to the managed CLI, and show the text ready to paste/send. This is the most important tutorial asset. -->

## First-Run Checklist

- AMO shows `BROKER LIVE` rather than a connection error.
- Workspace Check reports the actual deployment state.
- The selected adapter has a deployed version.
- Obsidian has loaded the generated vault once.
- The AMO Obsidian plugin version matches the expected version shown by the task-card settings.
- The managed CLI starts in the selected project directory.
- A completed reply creates a task card and generated note.
- Note and Canvas open without `Vault not found`.
- An annotation returns to the intended session.

## Where To Go Next

- [Reviewing With Notes](workflows/note-review.md)
- [Organizing Complex Work](workflows/canvas-work.md)
- [Shortcut Configuration](shortcut-configuration.md)
- [Local Data and Privacy](data-and-privacy.md)
- [Portable Release SOP](portable-release-sop.md)

