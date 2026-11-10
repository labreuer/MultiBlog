"use client";

import type { Editor } from "@tiptap/react";
import { useSession } from "next-auth/react";
import { PluginKey } from "@tiptap/pm/state";
import { searchMentionable } from "@/app/actions/mentions";
import { useChipSurface, useSeedChipContext } from "@/lib/entity-chips/chip-surface";
import { canInsertMentions, MENTION, type MentionUser } from "@/lib/entity-chips/kinds/mention";
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
// It needs to know what it is in (a doc, or a note), since that decides who
// is listed, so it renders nothing on a page that names no chip surface. A
// comment's editor names none, and mounts `MentionSuggestions` with a search
// of its own, asked of the post.
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

/** One row of the menu: who, and a note on the row, such as that they can't read where the mention goes. */
export type MentionRow = { user: MentionUser; note: string | null };

/** Where a menu's rows come from, and where the record of a picked one goes. */
export type MentionSource = {
  search: (query: string) => Promise<MentionRow[]>;
  seed: (user: MentionUser) => void;
};

/** The doc's or note's menu, from the chip surface the page names. */
export default function MentionMenu({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  const surface = useChipSurface();
  const seed = useSeedChipContext();
  const { data: session } = useSession();
  // Someone the rule lists nobody for gets no menu, rather than one that
  // opens on every "@" to say it found no one: a reader's note is the case.
  if (!surface || !session?.user || !canInsertMentions(session.user.role)) return null;
  const { target } = surface;
  // A comment's menu is CommentEditor's, which asks of the post.
  if (!target || "comment" in target) return null;

  return (
    <MentionSuggestions
      editor={editor}
      disabled={disabled}
      source={{
        search: async (query) =>
          (await searchMentionable(query, target)).map((candidate) => ({
            user: candidate.user,
            note: candidate.canRead ? null : `can't read this ${candidate.container}`,
          })),
        seed: (user) => seed(MENTION, user.id, user),
      }}
    />
  );
}

/** The menu itself, for whichever editor says where its rows come from. */
export function MentionSuggestions({ editor, disabled, source }: { editor: Editor; disabled?: boolean; source: MentionSource }) {
  return (
    <SuggestionMenu<MentionRow>
      editor={editor}
      disabled={disabled}
      pluginKey={suggestionKey}
      trigger="@"
      decorationClass="mention-query"
      allow={(state, range) => looksLikeAName(state.doc.textBetween(range.from + 1, range.to))}
      search={source.search}
      pick={(e, range, row) => {
        // The record the menu already has, so the chip is labelled as it
        // lands rather than after a round trip.
        source.seed(row.user);
        e.chain()
          .focus()
          .insertContentAt(range, [
            { type: ENTITY_CHIP, attrs: { kind: MENTION, iid: newChipIid(), data: { userId: row.user.id } } },
            { type: "text", text: " " },
          ])
          .run();
      }}
      itemKey={(row) => row.user.id}
      renderRow={(row) => (
        <>
          <span className={styles.linkResultTitle}>
            {row.user.name ?? row.user.slug}
            {row.user.botOf ? ` (${row.user.botOf})` : ""}
          </span>
          <span className={styles.linkResultMeta}>
            @{row.user.slug}
            {row.note ? ` · ${row.note}` : ""}
          </span>
        </>
      )}
      ariaLabel="People"
    />
  );
}
