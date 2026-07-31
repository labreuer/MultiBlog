import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canEditAnyPost } from "@/lib/authz";
import { extractText, diffText } from "@/lib/diff";
import { Prisma } from "@/generated/prisma/client";

// PLAN.md §15 — diffs one PUBLISHED/SCHEDULED event against the previous
// event (by createdAt) that actually carried content, the direct successor
// to the old revision-vs-revision diff. No restore button: re-publishing
// from an earlier point in the doc's own history (the scrub bar on
// /posts/[id]/edit) is what "restore" means now.
export default async function EventDiffPage({
  params,
}: {
  params: Promise<{ id: string; eventId: string }>;
}) {
  const { id, eventId } = await params;

  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const post = await prisma.post.findUnique({
    where: { id },
    include: { authors: { select: { userId: true } } },
  });
  if (!post) {
    notFound();
  }

  const isOwner = post.authors.some((a) => a.userId === session.user.id);
  if (!canEditAnyPost(session.user.role) && !isOwner) {
    return (
      <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Forbidden</h1>
        <p>You don&apos;t have permission to view this post&apos;s history.</p>
      </main>
    );
  }

  const target = await prisma.postPublicationEvent.findUnique({ where: { id: eventId } });
  if (!target || target.postId !== id || !target.proseJson) {
    notFound();
  }

  const previous = await prisma.postPublicationEvent.findFirst({
    where: { postId: id, proseJson: { not: Prisma.JsonNull }, createdAt: { lt: target.createdAt } },
    orderBy: { createdAt: "desc" },
  });

  const oldText = previous?.proseJson ? extractText(previous.proseJson) : "";
  const newText = extractText(target.proseJson);
  const tokens = diffText(oldText, newText);

  return (
    <main style={{ maxWidth: 720, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>
        {post.title} — {target.title}
      </h1>
      <p>
        <Link href={`/posts/${post.id}/history`}>Back to history</Link>
      </p>
      <p style={{ color: "#666" }}>
        {target.createdAt.toLocaleString()} · Diff against{" "}
        {previous ? `${previous.title} (${previous.createdAt.toLocaleString()})` : "(no earlier published version)"}
      </p>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          fontFamily: "inherit",
          border: "1px solid #ddd",
          borderRadius: 4,
          padding: 12,
        }}
      >
        {tokens.map((token, i) => {
          if (token.type === "insert") {
            return (
              <span key={i} style={{ background: "#d4f7d4", color: "#0a5" }}>
                {token.value}
              </span>
            );
          }
          if (token.type === "delete") {
            return (
              <span key={i} style={{ background: "#fbdada", color: "#c00", textDecoration: "line-through" }}>
                {token.value}
              </span>
            );
          }
          return <span key={i}>{token.value}</span>;
        })}
      </pre>
    </main>
  );
}
