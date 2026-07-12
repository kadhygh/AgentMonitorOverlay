# Local Data And Privacy

Status: first public-facing inventory. A complete code and release artifact audit is still required before the repository becomes public.

## Data Locations

Project-local AMO data is stored under the enrolled workspace:

```text
<project>/.amo/
```

This can include deployment metadata, hooks, adapter files, session notes, canvases, annotations, and diagnostic cache retained after failures or while debug retention is enabled.

Portable application state is stored under:

```text
<portable-root>/data/
```

Development mode may use repository-local Broker data instead. The active runtime mode and resolved data path should be included in diagnostics before public release.

## Local Services

The desktop client communicates with the local AMO Broker on `127.0.0.1`. Hooks and the Obsidian plugin use this local bridge to publish session events and request AMO actions.

AMO does not act as a model API proxy and does not replace Codex CLI, Claude CLI, Codex App, or Obsidian. Those external applications retain their own network, authentication, and data behavior.

## Network And Telemetry Audit

Before public release, verify and document every outbound request made by:

- AMO update checks;
- release and runtime download scripts;
- Tauri and bundled plugins at runtime;
- optional provider launch or integration paths.

Do not claim "no telemetry" until that audit has been completed against the shipped build. If AMO remains telemetry-free, state it explicitly here together with the version for which it was verified.

## Sensitive Content

Generated notes and hook payloads can contain source code, project paths, prompts, replies, and annotations. Users should treat `.amo` and Portable `data/` as potentially sensitive local material.

Before sharing a bug report:

- remove session content that is not required to reproduce the issue;
- redact usernames, project paths, tokens, and provider account details;
- prefer AMO diagnostic summaries over raw session payloads;
- never attach an entire `.amo` vault from a private project without reviewing it.

Before committing a project, use AMO's Git exclude support or configure the repository deliberately. Git ignore and Git exclude do not remove files that are already tracked.

