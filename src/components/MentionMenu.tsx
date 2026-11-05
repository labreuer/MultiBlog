"use client";

import type { Editor } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import { searchMentionable } from "@/app/actions/mentions";
import { useChipSurface, useSeedChipContext } from "@/lib/entity-chips/chip-surface";
import { MENTION, type MentionCandidate } from "@/lib/entity-chips/kinds/mention";
import { newChipIid } from "@/lib/entity-chips/node";
import { ENTITY_CHIP } from "@/lib/entity-chips/types";
import SuggestionMenu from "./SuggestionMenu";
import styles from "./EditorChrome.module.css";

// "@" opens a menu of the people this viewer may mention; Enter (or a click)
// replaces "@" and the query with a mention chip (docs/MENTIONS.md). The
// chip holds the person's id and nothing else: its label is computed, so it
// follows a rename.
//
// The menu itself is SuggestionMenu's, shared with "[[". What's this one's:
// the trigger, which opens only after a space or at a line's start
// (Suggestion's default), so an email address never opens it; the search,
// which is the server's one rule for who may be mentioned; and the rows.
//
// It needs to know which doc it is in, since that decides who is listed, so
// it renders nothing on a page that names no chip surface.
const suggestionKey = new PluginKey("mentionSuggestion");

// A query may hold spaces, for a full name, so something has to say when an
// "@" was never a mention: "meet @ 5pm, then lunch" would otherwise search on
// every keystroke to the paragraph's end. A name doesn't start with a space,
// and is a few words at most.
const MAX_QUERY_LENGTH = 40;
const MAX_QUERY_WORDS = 4;
function looksLikeAName(query: string): boolean {
  return query.length <= MAX_QUERY_LENGTH && !/^\s/.test(query) && query.trim().split(/\s+/).length <= MAX_QUERY_WORDS;
}

export default function MentionMenu({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const surface = useChipSurface();
  const seed = useSeedChipContext();
  if (!surface) return null;
  const { target } = surface;

  return (
    <SuggestionMenu<MentionCandidate>
      editor={editor}
      disabled={disabled}
      pluginKey={suggestionKey}
      trigger="@"
      decorationClass="mention-query"
      allow={(state, range) => looksLikeAName(state.doc.textBetween(range.from + 1, range.to))}
      search={(query) => searchMentionable(query, target)}
      pick={(e, range, candidate) => {
        // The record the menu already has, so the chip is labelled as it
        // lands rather than after a round trip.
        seed(MENTION, candidate.user.id, candidate.user);
        e.chain()
          .focus()
          .insertContentAt(range, [
            { type: ENTITY_CHIP, attrs: { kind: MENTION, iid: newChipIid(), data: { userId: candidate.user.id } } },
            { type: "text", text: " " },
          ])
          .run();
      }}
      itemKey={(candidate) => candidate.user.id}
      renderRow={(candidate) => (
        <>
          <span className={styles.linkResultTitle}>
            {candidate.user.name ?? candidate.user.slug}
            {candidate.user.botOf ? ` (${candidate.user.botOf})` : ""}
          </span>
          <span className={styles.linkResultMeta}>
            @{candidate.user.slug}
            {candidate.canRead ? "" : " · can't read this doc"}
          </span>
        </>
      )}
      ariaLabel="People"
    />
  );
}
