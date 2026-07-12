# Organizing Complex Work With Canvas

Canvas is the deliberate workspace for tasks whose structure matters more than their chronology.

## Base Flow And Work Canvas

AMO's generated base canvas is a chronological trace of prompt and reply notes. Treat it as working paper and provenance, not as a presentation that must remain tidy.

A work canvas is curated by the user. Add only the notes that help explain the current problem, decision, branch, or follow-up. Manual links and groups can express relationships that the original conversation did not know in advance.

## Suggested Workflow

1. Review replies through notes first.
2. Create a work canvas when the task develops meaningful branches.
3. From the AMO Obsidian panel, add the current note to an existing work canvas or create a new one.
4. Group related notes and add manual links where the relationship carries useful meaning.
5. Continue the CLI conversation normally; promote later notes only when they belong in the curated view.

The base canvas remains the complete generated trail. The work canvas remains a human-owned explanation of the task.

<!-- GIF TODO: Work canvas curation.
Open a generated reply note, use Add note to canvas, choose or create a work canvas,
then show the note focused in that canvas and connect it to one existing node. -->

## Canvas Development Boundary

AMO augments Obsidian Canvas rather than replacing its renderer. Plugin changes should prefer commands, selection state, metadata, overlays, and supported workspace APIs. Reimplementing Canvas node layout, zoom, edges, or core DOM behavior has a large regression surface and is intentionally outside the normal feature path.

See [Obsidian Canvas Development Guidelines](../agnets/obsidian-canvas-development-guidelines.md) before changing Canvas behavior.

