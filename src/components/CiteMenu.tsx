"use client";

import type { Editor } from "@tiptap/react";
import { useSession } from "next-auth/react";
import { PluginKey } from "@tiptap/pm/state";
import { searchCitable, type CiteCandidate } from "@/app/actions/references";
import { useChipSurface, useSeedChipContext } from "@/lib/entity-chips/chip-surface";
import { CITATION, normalizeLocator } from "@/lib/entity-chips/kinds/citation";
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
// The menu itself is SuggestionMenu's, shared with "[[" and "@".
const suggestionKey = new PluginKey("citeSuggestion");

const MAX_QUERY_LENGTH = 60;

/**
 * A query's words and the page it ends with, if it ends with one: "radner
 * 49", "barfield 49-51", "bu xii". A lone word is never a page, so "1984"
 * still finds the novel.
 */
export function splitLocator(query: string): { words: string; locator: string | null } {
  const match = /^(.*\S)\s+((?:pp?\.?\s*)?(?:\d+|[ivxlcdm]+)(?:\s*(?:-{1,2}|–)\s*(?:\d+|[ivxlcdm]+))?)$/i.exec(query.trim());
  return match ? { words: match[1], locator: normalizeLocator(match[2]) } : { words: query.trim(), locator: null };
}

export default function CiteMenu({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const surface = useChipSurface();
  const seed = useSeedChipContext();
  const { data: session } = useSession();
  // Like the mention menu, it needs a chip surface to hand the picked record
  // to, and renders nothing on a page that names none.
  if (!surface || !session?.user) return null;

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
        if (!words) return [];
        return (await searchCitable(words)).map((candidate) => ({ ...candidate, locator }));
      }}
      pick={(e, range, candidate) => {
        // The record the menu already has, so the chip is labelled as it lands.
        seed(CITATION, candidate.work.id, candidate.work);
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
    />
  );
}
