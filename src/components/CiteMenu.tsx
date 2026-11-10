"use client";

import type { Editor } from "@tiptap/react";
import { useSession } from "next-auth/react";
import { PluginKey } from "@tiptap/pm/state";
import { searchCitable } from "@/app/actions/references";
import { useChipSurface, useSeedChipContext } from "@/lib/entity-chips/chip-surface";
import { CITATION, splitTrailingPages, type CiteCandidate, type CitedWork } from "@/lib/entity-chips/kinds/citation";
import { newChipIid } from "@/lib/entity-chips/node";
import { ENTITY_CHIP } from "@/lib/entity-chips/types";
import SuggestionMenu from "./SuggestionMenu";
import styles from "./EditorChrome.module.css";

// "[@" opens a menu of the reference library; Enter (or a click) replaces
// "[@" and the query with a citation chip (docs/CITATIONS.md, "The menu").
// "[@" is Pandoc's citation opener, and it leaves "@" alone to the mention
// menu: that one opens only after a space or at a line's start, and "[" is
// neither.
//
// The chip holds which work, and the page when one was typed: "radner 49"
// finds Radner and cites page 49. Its label is computed from the doc's style
// and the reference's record, so it follows a correction to either.
//
// The menu itself is SuggestionMenu's, shared with "[[" and "@". A comment's
// editor mounts `CiteSuggestions` with a search of its own, asked of the post.
const suggestionKey = new PluginKey("citeSuggestion");

const MAX_QUERY_LENGTH = 60;

/**
 * A query's words and the pages it ends with, if it ends with any: "radner
 * 49", "barfield 49-51", "bu xii", "bu 49, 51", by the rule a citation's
 * Page holds to. A lone word is never a page, so "1984" still finds the
 * novel.
 */
export const splitLocator = splitTrailingPages;

/** Where a menu's works come from, and where the record of a picked one goes. */
export type CiteSource = {
  /** The works matching a query's words, the page already split off. Empty words: what to list before anything is typed. */
  search: (words: string) => Promise<CiteCandidate[]>;
  seed: (work: CitedWork) => void;
};

/** The doc's or note's menu: the whole library, for anyone signed in. */
export default function CiteMenu({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const surface = useChipSurface();
  const seed = useSeedChipContext();
  const { data: session } = useSession();
  // Like the mention menu, it needs a chip surface to hand the picked record
  // to, and renders nothing on a page that names none.
  if (!surface || !session?.user) return null;

  return (
    <CiteSuggestions
      editor={editor}
      disabled={disabled}
      source={{
        search: async (words) => (words ? searchCitable(words) : []),
        seed: (work) => seed(CITATION, work.id, work),
      }}
    />
  );
}

/** The menu itself, for whichever editor says where its works come from. */
export function CiteSuggestions({
  editor,
  disabled,
  source,
  emptyQueryHeading,
}: {
  editor: Editor;
  disabled?: boolean;
  source: CiteSource;
  /** Over the works listed before anything is typed, for a source that lists any. */
  emptyQueryHeading?: string;
}) {
  return (
    <SuggestionMenu<CiteCandidate & { locator: string | null }>
      editor={editor}
      disabled={disabled}
      pluginKey={suggestionKey}
      trigger="[@"
      allowedPrefixes={null}
      decorationClass="mention-query"
      // A closed "[@key]" is hand-written Pandoc, and a query doesn't run to the paragraph's end.
      allow={(state, range) => {
        const query = state.doc.textBetween(range.from + 2, range.to);
        return query.length <= MAX_QUERY_LENGTH && !query.includes("]");
      }}
      search={async (query) => {
        const { words, locator } = splitLocator(query);
        return (await source.search(words)).map((candidate) => ({ ...candidate, locator }));
      }}
      pick={(e, range, candidate) => {
        // The record the menu already has, so the chip is labelled as it lands.
        source.seed(candidate.work);
        e.chain()
          .focus()
          .insertContentAt(range, [
            {
              type: ENTITY_CHIP,
              attrs: {
                kind: CITATION,
                iid: newChipIid(),
                data: { items: [{ refId: candidate.work.id, ...(candidate.locator ? { locator: candidate.locator } : {}) }] },
              },
            },
            { type: "text", text: " " },
          ])
          .run();
      }}
      itemKey={(candidate) => candidate.work.id}
      renderRow={(candidate) => (
        <>
          <span className={styles.linkResultTitle}>
            {candidate.entry}
            {candidate.locator ? ` — p. ${candidate.locator}` : ""}
          </span>
          <span className={styles.linkResultMeta}>
            @{candidate.work.key}
            {candidate.work.short ? ` · ${candidate.work.short}` : ""}
          </span>
        </>
      )}
      ariaLabel="References"
      emptyQueryHeading={emptyQueryHeading}
    />
  );
}
