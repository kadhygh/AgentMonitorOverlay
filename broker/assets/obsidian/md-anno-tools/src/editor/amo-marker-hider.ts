import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";

const AMO_MARKER_LINE_PATTERN = /^\s*<!--\s*amo:\s*\{.*\}\s*-->\s*$/u;

export const amoMarkerHiderExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildAmoMarkerDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildAmoMarkerDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  }
);

function buildAmoMarkerDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const markerDecoration = Decoration.line({
    class: "amo-hidden-marker-line",
  });

  for (const range of view.visibleRanges) {
    let position = range.from;
    while (position <= range.to) {
      const line = view.state.doc.lineAt(position);
      if (AMO_MARKER_LINE_PATTERN.test(line.text)) {
        builder.add(line.from, line.from, markerDecoration);
      }
      if (line.to >= range.to) break;
      position = line.to + 1;
    }
  }

  return builder.finish();
}
