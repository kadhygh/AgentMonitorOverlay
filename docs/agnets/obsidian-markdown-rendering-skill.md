# Obsidian Markdown Rendering Skill

Updated: 2026-05-19

This document is the AMO project skill note for future Obsidian Markdown rendering work. It is intentionally practical: use it when changing `md-anno-tools` or any future AMO Obsidian plugin feature that mutates rendered Markdown.

## Core Model

Obsidian Markdown rendering is section-based. A Markdown postprocessor receives an element for a rendered preview section, not a stable whole-document DOM. A plugin can mutate that section, but the source Markdown file remains the source of truth.

Preferred rendering architecture:

1. Register one `registerMarkdownPostProcessor((el, ctx) => ...)` entry point for the feature.
2. Use `ctx.sourcePath` and `ctx.getSectionInfo(el)` to map rendered DOM back to source lines.
3. Parse the source file when the feature spans more than one Markdown section.
4. Attach custom rendering with `ctx.addChild(new MarkdownRenderChild(el))`.
5. Render nested Markdown with `MarkdownRenderer.render(app, markdown, targetEl, sourcePath, childComponent)` when the plugin-owned shell needs Obsidian-flavored Markdown inside it.
6. Let Obsidian unload and reload the render child when the section DOM is replaced.

## Rules

- Treat the source file as durable state. Treat preview DOM as disposable output.
- Keep custom render ownership local to the section passed by the postprocessor.
- If syntax spans sections, parse source lines and decide which source section owns the plugin shell.
- For a multi-section block, render one visible shell at the opening section and hide the remaining source sections with lifecycle-managed render children.
- Make rendering idempotent. A postprocessor may run many times and on different embedded views of the same file.
- Use per-section or per-node state when working inside Canvas. Do not compare one canvas-wide expected count against one canvas-wide actual count.
- Use debug events that include `sourcePath`, `lineStart`, `lineEnd`, role, and a short preview.
- Prefer Obsidian-native syntax, such as callouts or code blocks, when a feature can fit it.

## Anti-Patterns

- Do not make a global `MutationObserver` responsible for rendering logic. It may enqueue reconciliation, but it should not own state.
- Do not rely on raw marker text remaining in the rendered DOM after the plugin has already consumed or replaced it.
- Do not use cross-section `Range.deleteContents()` as the primary rendering strategy. Obsidian owns those sections and can replace or reuse them after edit/read transitions.
- Do not repair Canvas embedded notes at canvas-wide granularity. A single bad node can be hidden by another good node.
- Do not stack arbitrary timeout passes to chase renderer timing. If timing matters, the architecture is probably missing a source-backed lifecycle hook.
- Do not assume note reading mode and Canvas embedded note previews have the same lifecycle.

## AMO Annotation Pattern

Legacy AMO annotation syntax:

```markdown
[!anno]
> quoted source text

human annotation body
[/anno]
```

Stable render behavior:

- Parse the source file for standalone `[!anno]...[/anno]` blocks.
- Use section line numbers to identify whether a rendered section is the annotation opener, body, or closer.
- At the opener section, attach a `MarkdownRenderChild` that empties the section and creates `.anno-token-rich[data-amo-annotation="rich"]`.
- Render the inner annotation body with `MarkdownRenderer.render` so quoted Markdown stays native.
- For body and closer sections, attach a hide child that empties and hides the section.
- Inline annotation syntax inside a normal paragraph can still be handled by local text-node replacement if it does not span sections.

## Debug Checklist

For any Markdown rendering bug, capture:

- plugin version
- source path
- section line start/end
- section text preview
- whether raw markers exist in the section DOM
- whether the plugin-owned wrapper exists in the section DOM
- whether the rendered view is normal Markdown, Canvas embedded note, popout, or hover preview
- whether Obsidian was switching edit/read, opening a file, or updating a Canvas node

Recommended AMO debug events:

- `render.postprocessor`
- `render.legacy_section`
- `render.legacy_render_error`
- `render.inline_replaced`
- `render.canvas_node_target`

Avoid high-volume events for every mutation unless the overlay debug switch is enabled.

## Verification Checklist

Run the relevant subset after changing Markdown rendering:

- Open a note with one annotation for the first time.
- Toggle note edit/read at least 6 times; the shell, quote, and body should remain stable every time.
- Open the same note as a Canvas file node.
- Edit the Canvas embedded note and return to rendered preview at least 4 times.
- Put multiple annotated notes on the same Canvas and break only one node; rendering must repair that node without relying on other nodes.
- Test same-line standalone `[!anno]body[/anno]`.
- Test multi-line annotation with blockquote plus body.
- Test inline paragraph annotation with surrounding text.
- Copy and Send annotations after rendering changes; extraction still comes from source Markdown, not preview DOM.
- Reload the plugin or restart Obsidian and confirm the manifest version shown by `plugin.loaded`.

## References

- Obsidian API type definitions: `MarkdownPostProcessor`, `MarkdownPostProcessorContext`, `MarkdownRenderChild`, and `MarkdownRenderer`.
  https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts
- Obsidian developer docs: Markdown post processing and `MarkdownRenderChild` examples.
  https://marcusolsson.github.io/obsidian-plugin-docs/editor/markdown-post-processing
- Obsidian developer docs: `MarkdownPostProcessorContext.addChild`.
  https://obsidian-developer-docs.pages.dev/Reference/TypeScript-API/MarkdownPostProcessorContext/addChild
- Dataview API pattern: render custom views by adding child components to a `Component` or `MarkdownPostProcessorContext`.
  https://github.com/blacksmithgu/obsidian-dataview/blob/master/src/api/plugin-api.ts

