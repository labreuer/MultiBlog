import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canEditAnyPost } from "@/lib/authz";
import { nonDeletedPostWhere } from "@/lib/post-status";
import { extractText, diffText } from "@/lib/diff";
import RestoreRevisionButton from "@/components/RestoreRevisionButton";

export default async function RevisionDiffPage({
  params,
}: {
  params: Promise<{ id: string; revisionNumber: string }>;
}) {
  const { id, revisionNumber: revisionNumberParam } = await params;
  const revisionNumber = Number(revisionNumberParam);

  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const post = await prisma.post.findUnique({
    where: { id, ...nonDeletedPostWhere() },
    include: { authors: { select: { userId: true } } },
  });
  if (!post || !Number.isInteger(revisionNumber)) {
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

  const [target, previous] = await Promise.all([
    prisma.revision.findUnique({ where: { postId_revisionNumber: { postId: id, revisionNumber } } }),
    prisma.revision.findUnique({
      where: { postId_revisionNumber: { postId: id, revisionNumber: revisionNumber - 1 } },
    }),
  ]);
  if (!target) {
    notFound();
  }

  const oldText = previous ? extractText(previous.doc) : "";
  const newText = extractText(target.doc);
  const tokens = diffText(oldText, newText);

  return (
    <main style={{ maxWidth: 720, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>
        {post.title} — revision #{revisionNumber}
      </h1>
      <p>
        <Link href={`/posts/${post.id}/history`}>Back to history</Link>
      </p>
      <p style={{ color: "#666" }}>
        Diff against {previous ? `revision #${previous.revisionNumber}` : "(no earlier revision)"}
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
      <RestoreRevisionButton postId={post.id} revisionNumber={revisionNumber} />
    </main>
  );
}
