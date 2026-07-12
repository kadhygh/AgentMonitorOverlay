# Third-Party Redistribution Audit

Updated: 2026-07-13
Status: In progress
Release gate: Public source and binary release

## Purpose

This audit separates three questions that are easy to confuse:

1. Is AMO's own code licensed?
2. Are third-party dependencies used under compatible terms?
3. May every image, binary, font, and other asset in the final release be redistributed?

The root MIT License answers only the first question.

## Current Inventory

| Surface | Source or evidence | Current disposition |
| --- | --- | --- |
| AMO source and original application icon | Root `LICENSE`; application icon created for AMO | Cleared under AMO MIT License |
| Pinned Node.js runtime | Official `nodejs.org` archive and checksum; upstream `LICENSE` copied by build | Cleared when `runtime/NODE-LICENSE.txt` remains in the package |
| npm dependencies | Committed package lockfiles with package license metadata | Review direct dependency changes and retain required notices |
| Rust dependencies | Committed `Cargo.lock`; upstream crate metadata | Review direct dependency changes and retain required notices |
| Obsidian desktop application | Not bundled | External prerequisite; no redistribution by AMO |
| Codex CLI, Claude CLI, Codex App, Windows Terminal, Zed | Not bundled | External prerequisites; names used for interoperability |
| `overlay/src/assets/tool-icons/codex-cli.png` | No provenance record in repository | **Unresolved: do not approve for public binary distribution** |
| `overlay/src/assets/tool-icons/codex-app.png` | No provenance record in repository | **Unresolved: do not approve for public binary distribution** |
| `overlay/src/assets/tool-icons/claude-cli.png` | No provenance record in repository | **Unresolved: do not approve for public binary distribution** |

## Provider Icon Resolution

The preferred public-release resolution is:

1. locate official redistribution guidance for active provider artwork;
2. where redistribution is not explicitly supportable, replace vendor artwork with original neutral AMO provider glyphs;
3. record the source URL, retrieval date, license or brand-guideline URL, modifications, and file hash for every retained third-party image;
4. keep the trademark disclaimer even when artwork is replaced, because product names remain visible.

The abandoned Kiro integration and its installer-extracted icon were removed from active source and release inputs on 2026-07-13.

Do not treat a web-accessible logo, favicon, installed executable resource, or screenshot as automatically redistributable.

## Dependency Review Procedure

For each release candidate:

1. compare direct dependencies in all `package.json` and `Cargo.toml` files with the previous release;
2. inspect lockfile license metadata and upstream repositories for new packages;
3. flag copyleft, source-available, custom, missing, or ambiguous licenses for manual review;
4. generate a machine-readable dependency inventory for the release artifact;
5. verify that required license texts survive the packaging step;
6. retain the inventory with the release evidence.

An automated scanner can assist this review, but it does not decide trademark, artwork, or binary redistribution rights.

## Public Release Blockers

- Resolve provenance and redistribution status for all active provider icons.
- Generate and review npm and Cargo license inventories from the exact release lockfiles.
- Inspect bundled Tauri/WebView-related release artifacts for required notices.
- Confirm the final ZIP and Installer include `LICENSE`, `THIRD_PARTY_NOTICES.md`, and the Node.js license.
- Audit Git history and prior release assets for third-party files that are no longer present in the working tree.

## Current Security Audit Snapshot

On 2026-07-13, the Overlay build chain moved from Vite 5 with the Babel-based React plugin to Vite 6.4.3 with `@vitejs/plugin-react-swc` 4.3.1. This removed the vulnerable Vite, esbuild, and Babel dependency chain without moving the application to Vite 8.

After the upgrade, `npm audit` reports zero findings for both `overlay/` and the Obsidian plugin package. This is a point-in-time result, not a permanent guarantee; repeat both audits from committed lockfiles for each release candidate.

## Evidence Record Template

Use one entry per retained external asset:

```text
File:
Owner/project:
Original URL:
Retrieved:
License or brand guideline:
Allowed use:
Modifications:
SHA-256:
Reviewed by:
Review date:
```
