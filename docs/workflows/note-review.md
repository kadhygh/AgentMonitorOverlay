# Reviewing With Notes

Use this workflow for normal development tasks where the main need is careful review, not visual planning.

## Why Note First

Long AI replies contain both useful implementation detail and points that require human judgment. Writing a separate response from memory loses the connection between a concern and the source that created it.

AMO keeps that connection explicit:

```text
AI reply -> generated Obsidian note -> quoted annotation -> return to session
```

## Suggested Review Loop

1. Wait for the task card to enter Review.
2. Open the latest Note from the card.
3. Read normally until a sentence creates a question, correction, or new idea.
4. Select only the source text needed to understand that thought.
5. Add a quoted annotation and write the intended instruction beneath it.
6. Repeat without trying to compose the final prompt yet.
7. Review the collected annotations in the AMO panel.
8. Return them to the bound CLI or Codex App.

Quoted source text tells the session what the human is responding to. The annotation itself should contain the complete instruction; AMO does not need to prepend artificial numbering or generic prompt text.

## Scratchpad Before Annotation

Use Scratchpad when a thought is incomplete, spans several notes, or should not yet become permanent. It has three local pages and safe-copy behavior for CLI paste compatibility.

Move a thought into an annotation only when it has a clear relationship to a reply passage. This keeps notes useful without requiring every passing thought to become durable structure.

<!-- SCREENSHOT TODO: One finished reply note.
Show normal reply text, one quoted annotation with a short human instruction,
and the AMO Obsidian panel annotation list. Use fabricated technical content. -->

## When To Switch To Canvas

Stay with notes when the task is chronological and the next action is clear. Switch to a work canvas when you need to preserve branches, compare approaches, or connect several notes independently of conversation order.

