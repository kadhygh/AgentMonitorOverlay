# Shortcut Configuration

Status: implemented baseline for the public shortcut settings round.

## Principle

The author's side-button workflow is personal configuration, not a universal default:

| Action | Author's local binding |
| --- | --- |
| Open AMO Scratchpad | `Ctrl+Mouse4` |
| Contextual Obsidian annotation action | `Ctrl+Mouse5` |

These bindings are intentionally conservative on the author's machine to avoid colliding with ordinary mouse navigation. They are initialized by the Git-ignored `amo.local.json` profile and are not shipped as public defaults. Other users may not own a mouse with side buttons and are not forced into this layout.

## Public Behavior

- Public builds support keyboard-only Scratchpad use through `Ctrl+Alt+Space`; new installations start the global shortcut disabled and let the user opt in.
- Scratchpad settings offer keyboard, mouse-side-button, and disabled choices.
- Every global mouse shortcut must be individually enabled or disabled.
- User overrides must survive application updates and Obsidian plugin redeployment.
- Reset restores the public recommendation, not the author's private bindings.
- Native keyboard registration reports conflicts before saving.
- Settings display `Mouse4` and `Mouse5`; implementation-specific DOM button numbers stay internal.
- Obsidian keyboard commands remain owned by Obsidian's Hotkeys settings.
- AMO plugin settings own contextual mouse chords that Obsidian cannot represent as normal hotkeys.

## Storage And Migration

Represent a shortcut by logical action, modifiers, and named input instead of a raw event number. Apply a default only when a setting is absent. Never overwrite an existing user value during migration.

The author's development profile seeds the two local bindings above from `amo.local.json`. The file is ignored by Git; `amo.local.example.json` documents the supported profile without publishing machine-local state.

## Current Boundaries

- Scratchpad supports `Ctrl+Alt+Space`, Mouse4, Mouse5, and Ctrl-modified Mouse4/Mouse5.
- The Obsidian plugin settings control its contextual Mouse4/Mouse5 action and optional Ctrl requirement.
- Obsidian keyboard bindings remain in Obsidian's native Hotkeys page because the plugin already exposes normal AMO Commands.
- Existing explicit settings win over profile defaults and survive plugin update/redeployment.
- Arbitrary keyboard recording and a full cross-action conflict matrix remain future polish rather than a requirement for the initial public release.
