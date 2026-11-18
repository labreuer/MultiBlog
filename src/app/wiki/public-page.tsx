import Link from "next/link";
import * as Y from "yjs";
import type { JSONContent } from "@tiptap/core";
import { renderToReactElement } from "@tiptap/static-renderer";
import type { Role } from "@/generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { contentExtensions } from "@/lib/tiptap-schema";
import { readYdocContent } from "@/lib/ydoc-render";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { docJsonForPostSide } from "@/lib/post-content";
import { chipStylesOf, parseChipStyles } from "@/lib/entity-chips/settings";
import { docTitleOrFallback } from "@/lib/doc-title";
import { loadDocFamily } from "@/lib/doc-family";
import DocFamily from "@/components/DocFamily";
import { wikiNamespacePath, type WikiOwner } from "@/lib/wiki-address";
import proseStyles from "@/styles/prose.module.css";
import styles from "./wiki.module.css";

// docs/WIKI.md "Public pages" — a PUBLIC page for a reader signed out, or
// signed in without canViewDocs: a static render of its text, with its name
// and whose page it is, and nothing that reads past the text. No DocView, no
// providers, no annotations, no tags, no live connection and no scrub bar,
// whose endpoints keep their own gates; it reads no session below its
// route's gate and mounts nothing that would: the route hands it the viewer
// it read, for the family line's queries alone. No byline, by decision: a
// person's page names its owner, and a commons page credits nobody.

/** What the render reads of a page. */
export type PublicPageDoc = {
  id: string;
  title: string;
  proseJson: unknown;
  chipStyles: unknown;
  /** The family line's (docs/WIKI.md "The family line"). */
  wikiName: string | null;
  forkedFromDocId: string | null;
  forkedFromUpdateId: bigint | null;
  createdAt: Date;
};

/**
 * The body as the public may see it, through docJsonForPostSide, as the
 * landing page's preamble is: the doc-only marks stripped, entity chips
 * turned into their labelled links, the bibliography appended as text.
 * Without it the renderer refuses the doc's marks and chips, and the page
 * 500s. A page moved into the wiki before anything stored it has no
 * prose_json, so its body is decoded from the ydoc with the same conversion,
 * as postContentFromYdoc does; a ydoc that can't be read is shown as a page
 * with no text rather than a 500.
 */
async function publicBody(doc: PublicPageDoc): Promise<JSONContent | null> {
  if (doc.proseJson) return docJsonForPostSide(doc.proseJson as JSONContent, parseChipStyles(doc.chipStyles));
  const row = await prisma.ydoc.findUnique({ where: { id: ydocIdForDoc(doc.id) }, select: { ydoc: true } });
  if (!row) return null;
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(scratch, row.ydoc);
    const content = readYdocContent(scratch);
    return content.ok ? await docJsonForPostSide(content.bodyJSON, chipStylesOf(scratch)) : null;
  } catch {
    return null;
  } finally {
    scratch.destroy();
  }
}

/**
 * `viewer` is the route's, null signed out: a reader without canViewDocs,
 * whose family line names PUBLIC pages alone and links no diff.
 */
export default async function PublicWikiPage({
  doc,
  owner,
  viewer,
}: {
  doc: PublicPageDoc;
  owner: WikiOwner;
  viewer: { id: string; role: Role } | null;
}) {
  const [body, family] = await Promise.all([publicBody(doc), loadDocFamily(viewer, doc)]);
  return (
    <main className={styles.main} data-public-render="">
      <h1>{docTitleOrFallback(doc.title)}</h1>
      {/* Whose page it is links to the owner's namespace, not /authors/,
          which 404s once the account is deleted while its pages stay. */}
      <p className={styles.intro}>
        {owner.kind === "person" ? (
          <>
            A page in <Link href={wikiNamespacePath(owner)}>@{owner.slug}</Link>&apos;s namespace
          </>
        ) : (
          <>
            A page in the <Link href={wikiNamespacePath(owner)}>commons</Link>
          </>
        )}
      </p>
      {family && <DocFamily family={family} surface="public" />}
      <div className={proseStyles.prose}>
        {body ? renderToReactElement({ content: body, extensions: contentExtensions }) : <p className={styles.empty}>This page is empty.</p>}
      </div>
    </main>
  );
}
