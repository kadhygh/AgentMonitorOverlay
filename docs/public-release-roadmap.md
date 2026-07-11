# AMO Public Release Roadmap

Updated: 2026-07-11
Status: Planned
Target: Convert the existing `kadhygh/AgentMonitorOverlay` repository from private to public and use it as the single source of truth.

## Decision

AMO will not maintain separate private-source and public-release mirrors.

The current repository will be prepared in private, audited, and then changed to public visibility. After that conversion, the public repository will own:

- source code;
- user and contributor documentation;
- Issues, Discussions, and pull requests;
- Windows Installer and Portable builds;
- GitHub Releases;
- signed updater metadata and artifacts.

Repository visibility is repository-wide. There is no separate public branch inside a private repository. `master` remains the stable release branch, while implementation work uses short-lived feature branches.

## Release Model

AMO will publish two Windows x64 distributions:

| Distribution | Primary audience | Data location | Update behavior |
| --- | --- | --- | --- |
| NSIS Installer | Normal users | `%LOCALAPPDATA%\AMO\data` | Signed in-app update |
| Portable ZIP | Testing, recovery, removable use | `<portable-root>\data` | Version check and Release link initially |

The Installer is the default download. Portable remains a supported diagnostic and no-install option.

AMO bundles its Broker and pinned Node runtime. Codex CLI, Claude CLI, Obsidian, Windows Terminal, Zed, and other providers remain optional external integrations rather than mandatory installer dependencies.

## Branch And Release Policy

Use a short-lived release-foundation branch:

```text
master
  \- codex/release-foundation
```

The release-foundation branch is merged only after build, cold-start, upgrade, uninstall, and updater smoke checks pass.

After the repository becomes public:

- `master` is the stable branch;
- feature work uses `codex/<feature-name>` or normal contributor branches;
- releases are triggered only by immutable `v*` tags;
- a release tag must point to a commit already contained in `master`;
- force-push and deletion are disabled for `master` and release tags;
- required build checks protect release merges.

A permanent `develop` or `public` branch is not required for the current team size.

## Milestone 1: Product Identity

Before building an installer, stabilize the identity that Windows and the updater will retain across versions:

- choose the final product name displayed as `AMO`;
- replace the provisional Tauri identifier with a stable reverse-domain identifier;
- add final application, installer, tray, and notification icons;
- align versions in Tauri, Cargo, npm, Broker constants, deployment metadata, and Obsidian plugin metadata;
- add publisher and repository metadata;
- choose and add the source license;
- add `THIRD_PARTY_NOTICES.md` for bundled runtimes, libraries, icons, and trademarks.

Changing installer identity after public installation can create duplicate installations or break updater continuity, so this milestone is a release blocker.

## Milestone 2: Installer Foundation

Add a Tauri NSIS installer that:

- installs for the current user by default and does not require elevation;
- bundles `AMO.exe`, the Broker, the pinned Node runtime, Obsidian plugin assets, and required licenses;
- detects or bootstraps WebView2;
- creates Start Menu and uninstall entries;
- offers a desktop shortcut without forcing one;
- supports an optional startup-with-Windows setting controlled by AMO;
- upgrades application files without deleting user state;
- asks whether user data should be removed during an explicit uninstall.

Installed mode and Portable mode must resolve storage independently:

```text
Installed: %LOCALAPPDATA%\AMO\data
Portable:  <portable-root>\data
Development: repository broker/data paths
```

The runtime must expose its active mode and resolved storage paths in diagnostics.

## Milestone 3: Signed Updates

Integrate the official Tauri updater and process plugins.

Required behavior:

- display current version, latest version, release notes, and last-check time in Settings;
- allow an explicit `Check for updates` action;
- check once after a delayed startup and at most once every 24 hours;
- never download or install silently in the first release;
- show download progress and actionable errors;
- install only after user confirmation;
- restart AMO after a successful update;
- preserve the current working installation when download or signature validation fails.

Updater artifacts must be signed. The updater public key is committed to the repository; the private key and password exist only in protected GitHub Actions secrets and offline backup storage.

The stable endpoint will use this repository's public GitHub Releases after visibility conversion. Before conversion, the endpoint remains build-configurable so private test releases can validate the complete flow.

Portable v1 only checks availability and opens the matching Release page. In-place Portable replacement is deferred until there is a tested external replacement helper.

## Milestone 4: Developer Bootstrap

Add `scripts/setup-dev.ps1` for contributors, not end users.

Supported modes:

```powershell
.\scripts\setup-dev.ps1 -CheckOnly
.\scripts\setup-dev.ps1 -InstallMissing
```

The script should:

- inspect Git, Node/npm, Rust stable MSVC, Visual Studio C++ Build Tools, WebView2, and optional GitHub CLI;
- explain every missing dependency;
- use `winget` only after an explicit install mode is selected;
- run `npm ci` in the Overlay workspace;
- run the frontend production build and `cargo check`;
- produce a concise environment report suitable for bug reports;
- remain idempotent when rerun.

Normal AMO users must not need Node, npm, Rust, Visual Studio, or this script.

## Milestone 5: Public Documentation

Prepare these public-facing files before changing repository visibility:

```text
README.md
LICENSE
CHANGELOG.md
CONTRIBUTING.md
SECURITY.md
PRIVACY.md
CODE_OF_CONDUCT.md
THIRD_PARTY_NOTICES.md
docs/architecture/
docs/integrations/
docs/deployment/
docs/plugin-development/
docs/release/
docs/troubleshooting/
```

The documentation must explain:

- the Overlay, Broker, Hook, Workspace, Managed Launch, and Obsidian plugin ownership boundaries;
- what data AMO stores locally and where;
- all outbound network requests and whether telemetry exists;
- how to add or maintain a CLI adapter;
- how to build, smoke, release, and recover AMO;
- how users report security issues without publishing sensitive session data.

Historical plans may remain under an archive area if they contain no sensitive information. Raw session payloads, personal project notes, local debug captures, and machine-specific handoff material are not public documentation.

## Milestone 6: Public Readiness Audit

Repository history does not need to look polished, but the security and redistribution audit is mandatory.

Audit the complete Git history, current tree, tags, remote branches, release assets, and GitHub Actions logs for:

- tokens, cookies, passwords, private keys, and credentials;
- real session content, Hook payloads, annotations, and Obsidian notes;
- personal email addresses or machine-specific data that should not be public;
- proprietary project names, paths, screenshots, or source fragments;
- generated Broker state, caches, logs, dumps, and temporary files;
- third-party code, binaries, icons, trademarks, and assets without a documented redistribution basis.

If a credential ever entered Git or an Actions log, rotate it before publication. Deleting the current file is not sufficient.

Review the existing remote spike branches before conversion. Delete branches that have no continuing historical or technical value; otherwise accept that they will become public with the repository.

## Milestone 7: Public Conversion

Public conversion checklist:

1. Complete the full-history and Actions-log audit.
2. Resolve all credential and third-party redistribution findings.
3. Merge `codex/release-foundation` into `master`.
4. Push the verified `master` commit.
5. Confirm Installer and Portable cold smoke from repository-external paths.
6. Confirm a signed private test update from the previous installed version.
7. Remove obsolete remote branches and releases if desired.
8. Change the existing GitHub repository visibility to Public.
9. Enable branch and release-tag protections.
10. Enable and configure Issues, Discussions, security reporting, and Dependabot as desired.
11. Verify anonymous access to source, documentation, Releases, and updater metadata.
12. Publish the first public release, currently planned as `v0.2.0`.

## CI Release Contract

A public `v*` tag runs the shared release pipeline and produces:

```text
AMO-v<version>-win-x64-setup.exe
AMO-v<version>-win-x64-setup.exe.sig
AMO-v<version>-win-x64-portable.zip
AMO-v<version>-win-x64-portable.zip.sha256
latest.json
```

The workflow must:

- build from a clean Windows runner;
- use pinned or reviewed action versions;
- restore dependencies from lockfiles;
- run frontend and Rust checks;
- build Installer and Portable from the same commit;
- sign updater artifacts with protected secrets;
- upload checksums and updater metadata;
- fail rather than publish partial output;
- verify the published assets after upload.

Windows Authenticode signing is separate from the mandatory updater signature. It is recommended before broad public promotion to reduce SmartScreen friction, but the updater signature is required for the first automatic-update release.

## Acceptance Gate For v0.2.0

The first public release is ready only when:

- Installer and Portable start without a development checkout;
- no Node, npm, Rust, or PowerShell startup script is required by normal users;
- Installer upgrades preserve AMO state;
- uninstall behavior is explicit and tested;
- settings can check, download, verify, install, and recover from an update;
- the Obsidian plugin and deployed Hook versions are visible and updateable;
- Codex CLI, Codex App, and Claude CLI smoke paths still work;
- the full public-readiness audit has no unresolved high-risk finding;
- public documentation matches the shipped behavior;
- the GitHub Release assets pass independent checksum and version verification.

## Deferred Work

The following work is not required to make the repository public or ship `v0.2.0`:

- Microsoft Store distribution;
- automatic installation of optional CLI providers;
- silent background updates;
- Portable in-place self-replacement;
- a permanent private/public repository mirror;
- a permanent `develop` branch;
- rewriting history only to make the commit graph look cleaner.
