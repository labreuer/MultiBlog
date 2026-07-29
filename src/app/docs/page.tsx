import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { canManageDocs } from "@/lib/doc-authz";
import { canEditAnyPost } from "@/lib/authz";
import { createDoc } from "@/app/actions/docs";
import { docTitleOrFallback } from "@/lib/doc-title";
import DocsTable from "@/components/DocsTable";
import styles from "./page.module.css";

export default async function DocsPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!canManageDocs(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Docs</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage docs.</p>
      </main>
    );
  }

  const docs = await prismaIncludingDeleted.doc.findMany({
    where: canEditAnyPost(session.user.role) ? undefined : { authors: { some: { userId: session.user.id } } },
    orderBy: { createdAt: "desc" },
    include: {
      authors: {
        orderBy: { bylineOrder: "asc" },
        select: { user: { select: { adminInitials: true } } },
      },
    },
  });

  const rows = docs.map((doc) => ({
    id: doc.id,
    slug: doc.slug,
    // "Untitled" is a render-time fallback, never stored (PLAN.md §12n) —
    // applied here so DocsTable's link, sort, and search all see the same
    // string a user reads instead of an empty one.
    title: docTitleOrFallback(doc.title),
    authors: doc.authors.map((a) => a.user.adminInitials).join(", "),
    visibility: doc.visibility,
    createdAt: doc.createdAt,
    deleted: doc.deletedByUserId !== null,
  }));

  return (
    <main style={{ maxWidth: 1000, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Docs</h1>
      {/* A <div>, not <p> — <form> isn't valid inside <p> (HTML rejects a
          block-level descendant there), which React 19 also flags as a
          hydration error since the browser's own parser would silently
          close the <p> early and produce a different tree than SSR sent.
          A GET <Link> would let Next's hover-prefetch create docs nobody
          asked for (§12n) — creation is a real mutation, so it's a form
          submit, not a link to a title-collecting page. */}
      <div style={{ margin: "1em 0" }}>
        <form action={createDoc}>
          <button type="submit" className={styles.newDocButton}>
            + New doc
          </button>
        </form>
      </div>
      <DocsTable rows={rows} />
    </main>
  );
}
