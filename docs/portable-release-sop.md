# AMO Windows Portable Release SOP

Updated: 2026-07-11
Applies to: Windows x64 Portable ZIP releases

## Release Contract

The first AMO Portable format is a ZIP folder, not a single executable. It contains the Tauri application, a pinned Node runtime, the Broker source/runtime assets, persistent data storage, licenses, and version metadata.

Portable guarantees:

- no Node, npm, Rust, repository checkout, or PowerShell startup script is required on the target machine;
- `AMO.exe` starts the bundled Broker without a console window;
- Broker state lives under the package-local `data/` directory;
- moving the whole extracted folder preserves behavior and state;
- exiting the Tauri application stops only the Broker process that application started;
- an existing healthy Broker is reused, while a foreign process on port `17654` is rejected;
- Codex CLI, Claude CLI, Obsidian, Windows Terminal, and WebView2 remain external prerequisites for their respective features.

## Version Sources

Before release, keep these values aligned:

| Surface | Source |
| --- | --- |
| App/package version | `overlay/src-tauri/tauri.conf.json` and `overlay/src-tauri/Cargo.toml` |
| Frontend version | `overlay/package.json` |
| Deployment/hook protocol | `broker/lib/amo-constants.js` |
| Obsidian plugin version | `broker/assets/obsidian/md-anno-tools/manifest.json` |
| Bundled Node | `scripts/release/build-portable.ps1` default |

The release tag uses `v<major>.<minor>.<patch>`, for example `v0.1.0`. The ZIP uses `AMO-v0.1.0-win-x64.zip`.

## Local Build

Prerequisites on the build machine:

- Windows x64;
- Node/npm for the frontend build;
- stable Rust MSVC toolchain;
- Visual Studio C++ build tools required by Tauri;
- network access to `nodejs.org` for the pinned Node ZIP and checksum list.

Run from the repository root:

```powershell
.\scripts\release\build-portable.ps1 -Version 0.1.0
```

The script performs:

1. frontend production build;
2. locked Cargo release build;
3. official Node ZIP download and SHA256 verification;
4. minimal Broker and Obsidian plugin asset staging;
5. package-local `data/` creation;
6. `version.json`, README, and Node license generation;
7. ZIP creation and SHA256 output.

Outputs:

```text
dist/portable/AMO-v0.1.0-win-x64/
dist/portable/AMO-v0.1.0-win-x64.zip
dist/portable/AMO-v0.1.0-win-x64.zip.sha256
```

## Cold Smoke

Stop the development AMO Broker and Overlay first so port `17654` is free. Then run:

```powershell
.\scripts\release\smoke-portable.ps1 `
  -PortableRoot .\dist\portable\AMO-v0.1.0-win-x64
```

The smoke requires evidence that:

- `AMO.exe` starts;
- health responds from port `17654`;
- the Broker executable is exactly the packaged `runtime/node.exe`;
- the Broker script is exactly the packaged `app/broker/server.js`;
- storage resolves to package-local `data/sessions.json`;
- Workspace Registry responds;
- normal app exit stops the owned Portable Broker.

Manual acceptance before tagging:

1. extract the ZIP to a path outside the repository;
2. repeat in a path containing spaces and Chinese characters;
3. open Workspace Center and inspect an existing project;
4. deploy/update an Obsidian plugin from packaged assets;
5. launch Codex and Claude where installed;
6. verify Managed Launch, Note, Canvas, tray, notification, and restart persistence;
7. confirm no Broker console appears in normal mode.

## GitHub Release

The workflow `.github/workflows/release-portable.yml` uses the same build script. A pushed `v*` tag builds and publishes the ZIP and checksum.

Release sequence:

```powershell
git status --short
git push origin master
git tag -a v0.1.0 -m "AMO v0.1.0"
git push origin v0.1.0
```

Do not tag unless the local cold smoke passed and the commit is already on `origin/master`. Never overwrite a published tag; increment the patch version instead.

After the GitHub workflow finishes, verify:

- Release title and tag are correct;
- ZIP and `.sha256` are both present;
- downloaded checksum matches;
- release archive opens and contains one versioned root directory;
- `version.json` commit matches the tagged commit.

## Updating Portable

To update an extracted package while preserving state:

1. exit AMO from the tray;
2. keep the existing `data/` directory;
3. replace `AMO.exe`, `app/`, `runtime/`, `README.txt`, and `version.json` from the new release;
4. restart AMO;
5. use Workspace Center Update when deployment/hook/plugin versions changed.

## Failure Rules

- Node checksum mismatch: stop; never package the archive.
- Dirty staged release scope: stop and audit before commit/tag.
- Foreign owner on port `17654`: stop; do not kill it automatically.
- Portable smoke starts the system Node or repository Broker: release is invalid.
- App exits but owned Broker remains: release is invalid.
- GitHub Actions output differs from local script structure: fix the shared script rather than documenting two workflows.
