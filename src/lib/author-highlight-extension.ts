import { Mark, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep, ReplaceAroundStep, type Step } from "@tiptap/pm/transform";
import { isChangeOrigin } from "@tiptap/extension-collaboration";

export type AuthorHighlightOptions = {
  getAuthorId: () => string | null;
};

const authorHighlightKey = new PluginKey("authorHighlight");

// Maps a step's inserted range (in the doc coordinates right after that one
// step) forward to `transaction`'s final doc, then through every transaction
// dispatched after it in the same batch — the standard Mapping.slice/compose
// technique for turning "what did step i insert" into "where is that now".
function insertedRange(
  transaction: Transaction,
  stepIndex: number,
  laterTransactions: Transaction[],
): { from: number; to: number } | null {
  const stepMap = transaction.mapping.maps[stepIndex];
  let from: number | null = null;
  let to: number | null = null;
  stepMap.forEach((_oldStart: number, _oldEnd: number, newStart: number, newEnd: number) => {
    if (newEnd > newStart) {
      from = from === null ? newStart : Math.min(from, newStart);
      to = to === null ? newEnd : Math.max(to, newEnd);
    }
  });
  if (from === null || to === null) {
    return null;
  }

  const restOfTransaction = transaction.mapping.slice(stepIndex + 1);
  let mappedFrom = restOfTransaction.map(from, -1);
  let mappedTo = restOfTransaction.map(to, 1);
  for (const later of laterTransactions) {
    mappedFrom = later.mapping.map(mappedFrom, -1);
    mappedTo = later.mapping.map(mappedTo, 1);
  }

  return mappedTo > mappedFrom ? { from: mappedFrom, to: mappedTo } : null;
}

// Tags newly-typed text with an inline mark carrying the current user's id,
// so contributions can be highlighted per-author (Etherpad-style) — not a
// suggest/accept "tracked changes" workflow, just attribution. Stripped from
// the doc before it's ever persisted to a revision (see stripMarkFromDoc in
// tiptap-schema.ts); this mark only ever lives in the working Yjs session.
export const AuthorHighlight = Mark.create<AuthorHighlightOptions>({
  name: "authorHighlight",

  addOptions() {
    return {
      getAuthorId: () => null,
    };
  },

  addAttributes() {
    return {
      authorId: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-author-id"),
        renderHTML: (attributes) => (attributes.authorId ? { "data-author-id": attributes.authorId } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-author-id]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes, { class: "author-highlight" }), 0];
  },

  addProseMirrorPlugins() {
    const { getAuthorId } = this.options;
    const markType = this.type;

    return [
      new Plugin({
        key: authorHighlightKey,
        appendTransaction(transactions, _oldState, newState) {
          const authorId = getAuthorId();
          if (!authorId) {
            return null;
          }
          // We already handled this batch once and appended our own mark
          // transaction — without this guard, reprocessing it on the next
          // appendTransaction pass (which sees our own tr too) never
          // stabilizes and hangs the editor.
          if (transactions.some((t) => t.getMeta(authorHighlightKey))) {
            return null;
          }

          const localEdits = transactions.filter((t) => t.docChanged && !isChangeOrigin(t));
          if (localEdits.length === 0) {
            return null;
          }

          const tr = newState.tr;
          let changed = false;

          localEdits.forEach((transaction) => {
            const laterTransactions = transactions.slice(transactions.indexOf(transaction) + 1);
            transaction.steps.forEach((step: Step, stepIndex: number) => {
              if (!(step instanceof ReplaceStep) && !(step instanceof ReplaceAroundStep)) {
                return;
              }
              const range = insertedRange(transaction, stepIndex, laterTransactions);
              if (range) {
                tr.addMark(range.from, range.to, markType.create({ authorId }));
                changed = true;
              }
            });
          });

          if (!changed) {
            return null;
          }
          tr.setMeta(authorHighlightKey, true);
          return tr;
        },
      }),
    ];
  },
});
