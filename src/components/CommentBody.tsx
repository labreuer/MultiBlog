import type { ReactNode } from "react";
import type { Mark as PMMark, Node as PMNode } from "@tiptap/pm/model";
import { renderToReactElement, type NodeProps, type MarkProps } from "@tiptap/static-renderer";
import { commentContentExtensions } from "@/lib/tiptap-schema";
import type { CommentQuoteCitations } from "@/lib/comment-quote-citation";
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
// PLAN.md §23f/§23h — a blockquote or `quote` mark carrying an `anchorId` is a
// quotation of something else; `citations` (resolved server-side per anchor
// row, comment-quote-data.ts) says what and where. The words themselves are
// in the body, so a missing citation — a target that stopped being public,
// or a row this render was not handed — still shows the quote, just without
// the line under it. That is §23f's degradation, done at render.
//
// Falls back to the plain text on anything the renderer refuses, the same
// degradation AnnotationVersionBody has — a body that will not render is
// still worth reading.
type Props = {
  body: unknown;
  bodyText: string;
  citations?: CommentQuoteCitations;
};

// The renderer hands its mappings real ProseMirror nodes and marks — the JSON
// is parsed against the extensions first — so `attrs` is the schema's.
type NodeCtx = NodeProps<PMNode, ReactNode | ReactNode[]>;
type MarkCtx = MarkProps<PMMark, ReactNode | ReactNode[], PMNode>;

function Citation({ anchorId, citations }: { anchorId: string; citations: CommentQuoteCitations }) {
  const citation = citations[anchorId];
  if (!citation) return null;
  const text = citation.stale ? `${citation.label}, quoted an earlier version` : citation.label;
  return (
    <footer className={styles.citation} data-quote-anchor={anchorId}>
      — {citation.href ? <a href={citation.href}>{text}</a> : text}
    </footer>
  );
}

export default function CommentBody({ body, bodyText, citations = {} }: Props) {
  let rendered: ReactNode;
  try {
    rendered = renderToReactElement({
      content: body as never,
      extensions: commentContentExtensions,
      options: {
        nodeMapping: {
          blockquote: ({ node, children }: NodeCtx) => {
            const anchorId = typeof node.attrs.anchorId === "string" ? node.attrs.anchorId : null;
            return (
              <blockquote {...(anchorId ? { "data-anchor-id": anchorId } : {})}>
                {children}
                {anchorId && <Citation anchorId={anchorId} citations={citations} />}
              </blockquote>
            );
          },
        },
        markMapping: {
          quote: ({ mark, children }: MarkCtx) => {
            const anchorId = typeof mark.attrs.anchorId === "string" ? mark.attrs.anchorId : null;
            const citation = anchorId ? citations[anchorId] : undefined;
            const title = citation ? (citation.stale ? `${citation.label}, quoted an earlier version` : citation.label) : undefined;
            const q = (
              <q {...(anchorId ? { "data-anchor-id": anchorId } : {})} title={title}>
                {children}
              </q>
            );
            return citation?.href ? (
              <a href={citation.href} className={styles.inlineCitation}>
                {q}
              </a>
            ) : (
              q
            );
          },
        },
      },
    });
  } catch {
    rendered = <p>{bodyText}</p>;
  }
  return <div className={`${proseStyles.prose} ${styles.body}`}>{rendered}</div>;
}
