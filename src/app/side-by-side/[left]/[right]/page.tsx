import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import type { JSONContent } from "@tiptap/react";
import type { ReactNode } from "react";
import { renderToReactElement } from "@tiptap/static-renderer";
import * as Y from "yjs";
import { prisma } from "@/lib/prisma";
import { resolveDocParam } from "@/lib/resolve-doc-param";
import { gated, titleWhenOk } from "@/lib/route-access";
import { canUserReadDoc } from "@/lib/doc-authz";
import { docTitleOrFallback } from "@/lib/doc-title";
import { docContentExtensions } from "@/lib/tiptap-schema";
import { renderYdocDoc } from "@/lib/ydoc-render";
import { ydocIdForDoc } from "@/lib/ydoc-names";
import { getDocLinkGroupsForPair, countOtherDocLinks } from "@/lib/doc-links-query";
import { signInPath } from "@/lib/sign-in-redirect";
import SideBySideView from "@/components/sidebyside/SideBySideView";
import styles from "./page.module.css";

// PLAN.md §14c — two path segments, not one `[left]+[right]` segment: Next
// percent-encodes string params before user code sees them
// (getParamValue in next/dist/shared/lib/router/utils/get-dynamic-param.js),
// so a single `/side-by-side/a+b` segment would arrive as
// params.pair === "a%2Bb" and any split("+") would 404 every URL in the
// feature. Two segments sidestep that entirely. Kebab-case to match every
// other multi-word route (ydoc-debug, site-settings, forgot-password).

const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

const DOC_SELECT = {
  id: true,
  title: true,
  visibility: true,
  proseJson: true,
  deletedByUserId: true,
} as const;

type LoadedDoc = NonNullable<Awaited<ReturnType<typeof resolveDocParam<typeof DOC_SELECT>>>>;

async function loadBody(doc: LoadedDoc): Promise<{ bodyJSON: JSONContent; staticBody: ReactNode }> {
  if (doc.proseJson) {
    const bodyJSON = doc.proseJson as JSONContent;
    return { bodyJSON, staticBody: renderToReactElement({ content: bodyJSON, extensions: docContentExtensions }) };
  }

  // decode-from-ydoc fallback (§12d) — prose_json is still null because no
  // store debounce has fired yet, e.g. a doc that was created but never
  // edited. Same fallback /doc/[slug]/page.tsx uses.
  const row = await prisma.ydoc.findUnique({ where: { id: ydocIdForDoc(doc.id) }, select: { ydoc: true } });
  const scratch = new Y.Doc();
  if (row) Y.applyUpdate(scratch, row.ydoc);
  const result = renderYdocDoc(scratch);
  scratch.destroy();
  if (result.ok) {
    return { bodyJSON: result.bodyJSON, staticBody: result.body };
  }
  return { bodyJSON: EMPTY_DOC, staticBody: <p style={{ color: "var(--error)" }}>{result.error}</p> };
}

// The two-argument case the envelope's memo was built to take: `gated` keys on
// every argument, so a pair resolves once for the request just as a single doc
// does.
//
// §14c — if either doc is unreadable the *whole page* is forbidden rather than
// one column beside a placeholder: this page's only purpose is comparison, and
// the "Link to…" picker (§14k) only ever offers docs the viewer can already
// read, so the sole way to reach a mismatched pair is a shared URL. The title
// answers the same way rather than leaking half a pair.
const loadPairForRead = gated(async (user, left: string, right: string) => {
  const [leftDoc, rightDoc] = await Promise.all([
    resolveDocParam(left, DOC_SELECT),
    resolveDocParam(right, DOC_SELECT),
  ]);
  if (!leftDoc || leftDoc.deletedByUserId !== null || !rightDoc || rightDoc.deletedByUserId !== null) {
    return "not-found";
  }
  // §14c — two columns on one doc would build two distinct Y.Docs sharing
  // one documentName, which is exactly the y-indexeddb#25 shape Phase 0's
  // attachIndexeddb re-key guards against from the client side; rejecting
  // it here is also a semantic rejection, not just a workaround — a link
  // with both ends in one doc has no representation in "← N  M → (+Y)".
  if (leftDoc.id === rightDoc.id) {
    return "not-found";
  }
  const [leftReadable, rightReadable] = await Promise.all([
    canUserReadDoc(user.id, user.role, leftDoc),
    canUserReadDoc(user.id, user.role, rightDoc),
  ]);
  if (!leftReadable || !rightReadable) {
    return "forbidden";
  }
  return { leftDoc, rightDoc };
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ left: string; right: string }>;
}): Promise<Metadata> {
  const { left, right } = await params;
  return titleWhenOk(
    await loadPairForRead(left, right),
    ({ leftDoc, rightDoc }) => `${docTitleOrFallback(leftDoc.title)} ∥ ${docTitleOrFallback(rightDoc.title)}`,
  );
}

// Dynamic for the same reasons /doc/[slug]/page.tsx is (§12f): per-user
// gated, and the decode-from-ydoc fallback above is a live decode.
export default async function SideBySidePage({
  params,
}: {
  params: Promise<{ left: string; right: string }>;
}) {
  const { left, right } = await params;
  // Free — generateMetadata already ran this for the same request.
  const access = await loadPairForRead(left, right);
  if (access.status === "signed-out") {
    redirect(signInPath(`/side-by-side/${left}/${right}`));
  }
  if (access.status === "redirect") {
    redirect(access.to);
  }
  if (access.status === "not-found") {
    notFound();
  }
  if (access.status === "forbidden") {
    return (
      <main className={styles.forbidden}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to read both of these docs.</p>
      </main>
    );
  }
  const {
    value: { leftDoc, rightDoc },
    user,
  } = access;

  const [leftBody, rightBody, groups] = await Promise.all([
    loadBody(leftDoc),
    loadBody(rightDoc),
    getDocLinkGroupsForPair(leftDoc.id, rightDoc.id),
  ]);
  const otherDocLinksCount = await countOtherDocLinks(
    groups.map((g) => g.id),
    leftDoc.id,
    rightDoc.id,
  );

  return (
    <main className={styles.container}>
      <SideBySideView
        left={{
          docId: leftDoc.id,
          initialTitle: docTitleOrFallback(leftDoc.title),
          initialBodyJSON: leftBody.bodyJSON,
          staticBody: leftBody.staticBody,
        }}
        right={{
          docId: rightDoc.id,
          initialTitle: docTitleOrFallback(rightDoc.title),
          initialBodyJSON: rightBody.bodyJSON,
          staticBody: rightBody.staticBody,
        }}
        initialGroups={groups}
        initialOtherDocLinksCount={otherDocLinksCount}
        userId={user.id}
        userName={user.name ?? user.email ?? "Anonymous"}
        userColor={user.color}
      />
    </main>
  );
}
