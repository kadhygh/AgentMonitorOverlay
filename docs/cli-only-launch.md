# Launch CLI without deployment

In Workspace Center, paste or choose an existing folder and click **Launch CLI** beside Choose and Check. Checking or deploying the folder first is not required. Select Codex CLI, Claude CLI, or Grok Build, then select a provider and launch. The existing terminal preference and stored provider credentials are reused. Codex default stays first; DXX is available.

The folder need not be a Git repository. The CLI must already be installed. Invalid directories are rejected by the Broker. A successful launch opens a terminal; errors inside the CLI (including missing commands or API failures) remain visible there.

This mode creates no managed launch record, adds no AMO deployment files to the selected folder, and does not wait for hooks. Existing global/project hooks may still emit events. It starts new CLI sessions only; managed resume and Codex App launches retain their existing workflow. The last successfully used CLI folder is remembered for the next Workspace Center window.
