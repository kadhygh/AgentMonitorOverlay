# Third-Party Notices

AMO is distributed under the MIT License. It also uses third-party software under each component's own license. AMO's license does not replace or modify those licenses.

This file summarizes the principal components used by the current Windows application and development toolchain. Exact versions are recorded in `overlay/package-lock.json`, `overlay/src-tauri/Cargo.lock`, and `broker/assets/obsidian/md-anno-tools/package-lock.json`.

## Runtime And Application Components

| Component | Project | License |
| --- | --- | --- |
| Node.js | <https://nodejs.org/> | MIT and bundled third-party notices |
| Tauri | <https://tauri.app/> | Apache-2.0 OR MIT |
| React and React DOM | <https://react.dev/> | MIT |
| Lucide | <https://lucide.dev/> | ISC |
| Rust `windows` / `windows-sys` crates | <https://github.com/microsoft/windows-rs> | Apache-2.0 OR MIT |
| Tauri Notification plugin | <https://github.com/tauri-apps/plugins-workspace> | Apache-2.0 OR MIT |

The Portable package includes a pinned Node.js executable. Its complete upstream license is copied into the package as `runtime/NODE-LICENSE.txt` by the release build.

## Obsidian Plugin Build Components

| Component | Project | License |
| --- | --- | --- |
| Obsidian API type package | <https://github.com/obsidianmd/obsidian-api> | MIT |
| esbuild | <https://esbuild.github.io/> | MIT |
| TypeScript | <https://www.typescriptlang.org/> | Apache-2.0 |

Obsidian itself is not bundled with AMO. Users install and operate it separately under Obsidian's own terms.

## Development Components

| Component | Project | License |
| --- | --- | --- |
| Vite | <https://vite.dev/> | MIT |
| Tauri CLI | <https://tauri.app/> | Apache-2.0 OR MIT |

Development-only dependencies are not necessarily distributed in the Portable package. They remain covered by the licenses recorded in the package lockfiles and upstream distributions.

## Product Names And Trademarks

Codex, Claude, Obsidian, Kiro, Zed, Windows, and other product names and marks belong to their respective owners. AMO uses these names only to describe optional interoperability. AMO is not affiliated with, endorsed by, or sponsored by those owners.

Third-party product artwork is not covered by AMO's MIT License. Provider artwork must pass the repository's redistribution audit before it can be included in a public release.

## Source And License Review

Before publishing a release, maintainers must:

1. build from the committed lockfiles;
2. review newly introduced direct and bundled dependencies;
3. preserve license or notice files required by bundled components;
4. resolve every open asset finding in `docs/third-party-audit.md`;
5. inspect the final Installer and Portable contents, not only the source tree.

Report a missing or incorrect attribution through the repository issue tracker.

