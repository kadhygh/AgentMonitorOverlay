# Shortcut Configuration

Status: design contract for the public shortcut settings round.

## Principle

The author's side-button workflow is personal configuration, not a universal default:

| Action | Author's local binding |
| --- | --- |
| Open AMO Scratchpad | `Ctrl+Mouse4` |
| Contextual Obsidian annotation action | `Ctrl+Mouse5` |

These bindings are intentionally conservative on the author's machine to avoid colliding with ordinary mouse navigation. Other users may not own a mouse with side buttons and must not be forced into this layout.

## Public Behavior

- Public builds must support keyboard-only use.
- First-run setup should offer keyboard, mouse-side-button, and disabled choices.
- Every global mouse shortcut must be individually enabled or disabled.
- User overrides must survive application updates and Obsidian plugin redeployment.
- Reset restores the public recommendation, not the author's private bindings.
- Shortcut capture must report conflicts before saving.
- Settings display `Mouse4` and `Mouse5`; implementation-specific DOM button numbers stay internal.
- Obsidian keyboard commands remain owned by Obsidian's Hotkeys settings.
- AMO plugin settings own contextual mouse chords that Obsidian cannot represent as normal hotkeys.

## Storage And Migration

Represent a shortcut by logical action, modifiers, and named input instead of a raw event number. Apply a default only when a setting is absent. Never overwrite an existing user value during migration.

The author's development profile may seed the two local bindings above, but that profile must not be included as the public default or committed with machine-local state.

