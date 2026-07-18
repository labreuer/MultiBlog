import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export type QuoteHighlightThread = {
  id: string;
  from: number;
  to: number;
  count: number;
};

export type QuoteHighlightOptions = {
  threads: QuoteHighlightThread[];
  onIndicatorClick: (threadId: string) => void;
};

const quoteHighlightKey = new PluginKey("quoteHighlight");

// Splits threads' ranges into the minimal set of non-overlapping segments,
// each tagged with every thread that covers it. Needed because when two
// Decoration.inline ranges overlap, ProseMirror doesn't reliably preserve
// both decorations' custom (data-*) attributes on the shared span for the
// overlapping portion — one silently wins and the other's attribute is
// dropped, which made a fully-nested quote (e.g. "kind" inside "kind of")
// vanish from the DOM entirely. Building our own non-overlapping segments
// up front sidesteps that instead of relying on ProseMirror's merge.
function buildSegments(
  threads: QuoteHighlightThread[],
  docSize: number,
): { from: number; to: number; threadIds: string[] }[] {
  const ranges = threads
    .map((t) => ({ id: t.id, from: Math.max(0, Math.min(t.from, docSize)), to: Math.max(0, Math.min(t.to, docSize)) }))
    .filter((t) => t.to > t.from);

  const boundaries = Array.from(new Set(ranges.flatMap((r) => [r.from, r.to]))).sort((a, b) => a - b);

  const segments: { from: number; to: number; threadIds: string[] }[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const from = boundaries[i];
    const to = boundaries[i + 1];
    const threadIds = ranges.filter((r) => r.from <= from && r.to >= to).map((r) => r.id);
    if (threadIds.length > 0) {
      segments.push({ from, to, threadIds });
    }
  }
  return segments;
}

// Read-only decoration layer: an inline highlight over each active thread's
// quoted range, plus a small clickable count badge at its end. Display-only
// — never touches the stored document, per PLAN.md §5.
export const QuoteHighlight = Extension.create<QuoteHighlightOptions>({
  name: "quoteHighlight",

  addOptions() {
    return {
      threads: [],
      onIndicatorClick: () => {},
    };
  },

  addProseMirrorPlugins() {
    const { threads, onIndicatorClick } = this.options;

    return [
      new Plugin({
        key: quoteHighlightKey,
        props: {
          decorations: (state) => {
            const docSize = state.doc.content.size;
            const decorations: Decoration[] = [];

            for (const segment of buildSegments(threads, docSize)) {
              decorations.push(
                Decoration.inline(segment.from, segment.to, {
                  class: "quote-highlight",
                  "data-thread-ids": segment.threadIds.join(" "),
                }),
              );
            }

            for (const thread of threads) {
              const to = Math.max(0, Math.min(thread.to, docSize));
              const from = Math.max(0, Math.min(thread.from, docSize));
              if (to <= from) {
                continue;
              }
              decorations.push(
                Decoration.widget(to, () => {
                  const badge = document.createElement("button");
                  badge.type = "button";
                  badge.className = "quote-indicator";
                  badge.textContent = String(thread.count);
                  badge.setAttribute(
                    "aria-label",
                    `${thread.count} comment${thread.count === 1 ? "" : "s"} on this quote`,
                  );
                  badge.addEventListener("click", (event) => {
                    event.preventDefault();
                    onIndicatorClick(thread.id);
                  });
                  return badge;
                }),
              );
            }

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
