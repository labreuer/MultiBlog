import { renderToReactElement } from "@tiptap/static-renderer";
import { commentContentExtensions } from "@/lib/tiptap-schema";
import proseStyles from "@/styles/prose.module.css";
import styles from "./CommentBody.module.css";

// PLAN.md §23b — a comment body, rendered from its stored JSON. The render
// path is `renderToReactElement` over the same extensions that validated it,
// never `dangerouslySetInnerHTML`: there is no HTML anywhere between the
// commenter and the reader. Usable from a Server Component and from inside a
// client one (CommentNode) alike — the renderer is pure.
//
// `.prose` because globals.css strips list and blockquote styling site-wide
// (CLAUDE.md); the module beside this pulls the type back to the page's own
// font so a comment doesn't read as an excerpt of the article.
//
// Falls back to the plain text on anything the renderer refuses, the same
// degradation AnnotationVersionBody has — a body that will not render is
// still worth reading.
export default function CommentBody({ body, bodyText }: { body: unknown; bodyText: string }) {
  let rendered: React.ReactNode;
  try {
    rendered = renderToReactElement({ content: body as never, extensions: commentContentExtensions });
  } catch {
    rendered = <p>{bodyText}</p>;
  }
  return <div className={`${proseStyles.prose} ${styles.body}`}>{rendered}</div>;
}
