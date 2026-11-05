"use client";

import type { Editor } from "@tiptap/react";
import { PluginKey } from "@tiptap/pm/state";
import { searchLinkableDocs } from "@/app/actions/docs";
import type { LinkableDocJson } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { relativeTime } from "@/lib/relative-time";
import SuggestionMenu from "./SuggestionMenu";
import styles from "./EditorChrome.module.css";

// "[[" at the caret opens a menu of readable docs that filters as you keep
// typing; Enter (or a click) replaces "[[" and the query with the chosen
// doc's title, linked to /doc/<slug>. The Obsidian / Roam / Notion gesture
// for dropping a reference into running text, and the other half of the
// link popover (LinkControls): Ctrl-K is for linking text you already have,
// this is for a reference you don't have text for yet — the query is
// transient, understood to be replaced, which is what the popover's title
// box could never assume.
//
// The menu itself — trigger, keyboard, placement — is SuggestionMenu's,
// shared with the mention menu. What's this one's: the trigger, which may
// follow anything; `allow`, which keeps a closed "[[a]]" from being a
// context; the search; and the rows.
//
// What's typed right after a pick stays out of the link because the schema's
// link mark is not inclusive (tiptap-schema.ts).
const TRIGGER = "[[";
const CLOSE = "]]";

const suggestionKey = new PluginKey("docRefSuggestion");

export default function DocRefMenu({ editor, disabled }: { editor: Editor; disabled?: boolean }) {
  return (
    <SuggestionMenu<LinkableDocJson>
      editor={editor}
      disabled={disabled}
      pluginKey={suggestionKey}
      trigger={TRIGGER}
      // Anywhere, not only after a space: "word[[" is as good a place to
      // drop a reference as " [[".
      allowedPrefixes={null}
      decorationClass="doc-ref-query"
      // Not a context: a pair already closed ("[[a]]x" — Suggestion's match
      // runs to the caret and would carry the "]]" in its query).
      allow={(state, range) => !state.doc.textBetween(range.from, range.to).includes(CLOSE)}
      search={searchLinkableDocs}
      pick={(e, range, doc) => {
        e.chain()
          .focus()
          .insertContentAt(range, {
            type: "text",
            text: docTitleOrFallback(doc.title),
            marks: [{ type: "link", attrs: { href: `/doc/${doc.slug}` } }],
          })
          .run();
      }}
      itemKey={(doc) => doc.id}
      renderRow={(doc, { receivedAt }) => (
        <>
          <span className={styles.linkResultTitle}>{docTitleOrFallback(doc.title)}</span>
          <span className={styles.linkResultMeta}>Edited {relativeTime(doc.updatedAt, receivedAt)}</span>
        </>
      )}
      ariaLabel="Docs"
      emptyQueryHeading="Recently edited"
      noMatchText="No docs match"
    />
  );
}
