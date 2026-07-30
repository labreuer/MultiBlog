import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { buildSegments } from "./decoration-segments";

export type QuoteHighlightThread = {
  id: string;
  from: number;
  to: number;
  count: number;
  color: string;
};

export type QuoteHighlightOptions = {
  threads: QuoteHighlightThread[];
  onIndicatorClick: (threadId: string) => void;
};

const quoteHighlightKey = new PluginKey("quoteHighlight");

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
                  "data-thread-ids": segment.ids.join(" "),
                  ...(segment.color ? { style: `--thread-color:${segment.color}` } : {}),
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
                  badge.style.setProperty("--thread-color", thread.color);
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
