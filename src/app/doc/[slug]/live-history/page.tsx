import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { resolveDocParam } from "@/lib/resolve-doc-param";
import { canUserEditDoc } from "@/lib/doc-authz";
import DocLiveHistory from "@/components/DocLiveHistory";

// §11h's replay slider, rehoused over a doc's own ydoc_update (PLAN.md
// §12k). With snapshots deferred (§12m) a doc has no ydoc_snapshot rows, so
// every rebuild here walks back to row #1 — a performance characteristic of
// this phase, not a defect (see /api/doc/[id]/replay's own comment).
export default async function DocLiveHistoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const doc = await resolveDocParam(slug, { id: true, title: true });
  if (!doc) {
    notFound();
  }

  if (!(await canUserEditDoc(session.user.id, session.user.role, doc.id))) {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to view this doc&apos;s history.</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 800, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>History: {doc.title}</h1>
      <p style={{ marginTop: "1em", marginBottom: "2em" }}>
        <Link href={`/doc/${doc.id}/edit`}>Back to editor</Link>
      </p>
      <DocLiveHistory docId={doc.id} />
    </main>
  );
}
