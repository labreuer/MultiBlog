import { Fragment } from "react";
import type { HeadlineFragment } from "@/lib/search/headline";

// docs/FULLTEXT.md §4 — a parsed `ts_headline` as text and `<mark>`s.
//
// Strings only, through React: the headline is the author's own text, which
// `ts_headline` does not escape, so it is never treated as HTML and nothing
// here uses `dangerouslySetInnerHTML`. Fragments are joined by an ellipsis,
// the way an excerpt elides what lies between them.
export default function Highlighted({ fragments, className }: { fragments: HeadlineFragment[]; className?: string }) {
  return (
    <span className={className}>
      {fragments.map((parts, i) => (
        <Fragment key={i}>
          {i > 0 && " … "}
          {parts.map((part, j) => (part.match ? <mark key={j}>{part.text}</mark> : <Fragment key={j}>{part.text}</Fragment>))}
        </Fragment>
      ))}
    </span>
  );
}
