# Obsidian Sync-Back Test Vault Seed

This folder is the tracked seed for the disposable vault used by Task H.

Tracked seed:

- `Notes/codex-task-h-test.md`

Materialized local vault:

- `tmp/obsidian-sync-back-vault/`

To materialize or refresh the local vault:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\obsidian\Prepare-SyncBackTestVault.ps1
```

After that, open the local vault manually in Obsidian and enable the local plugin from:

```text
.obsidian/plugins/amo-sync-back-test
```

Recommended manual test order:

1. Open `Notes/codex-task-h-test.md`
2. Run `AMO: Insert Annotation Block`
3. Run `AMO: Summarize Active Note Annotations`
4. Run `AMO: Copy Summary and Focus Target Session`

Expected behavior for step 4 in this spike:

- summary copied to clipboard
- sync-back request written to vault outbox
- helper attempts target window resolution
- final send still remains manual
