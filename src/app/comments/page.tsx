import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canManagePosts, canEditAnyPost } from "@/lib/authz";
import type { Prisma } from "@/generated/prisma/client";
import CommentsTable from "@/components/CommentsTable";

// Deep-link-only filters (no dedicated dropdown yet — see the page's Help
// section): ?post=<postId>, ?author=<userId>, ?commenter=<commenterId>.
// Combined with whatever role-based post scoping already applies below.
function parseDeepLinkWhere(searchParams: Record<string, string | string[] | undefined>): Prisma.CommentWhereInput {
  const where: Prisma.CommentWhereInput = {};
  const post = searchParams.post;
  const author = searchParams.author;
  const commenter = searchParams.commenter;

  const threadWhere: Prisma.CommentThreadWhereInput = {};
  if (typeof post === "string" && post) {
    threadWhere.postId = post;
  }
  if (typeof author === "string" && author) {
    threadWhere.post = { authors: { some: { userId: author } } };
  }
  if (Object.keys(threadWhere).length > 0) {
    where.thread = threadWhere;
  }
  if (typeof commenter === "string" && commenter) {
    where.commenterId = commenter;
  }
  return where;
}

export default async function CommentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!canManagePosts(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Comments</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage comments.</p>
      </main>
    );
  }

  const resolvedSearchParams = await searchParams;
  const scopeWhere: Prisma.CommentWhereInput = canEditAnyPost(session.user.role)
    ? {}
    : { thread: { post: { authors: { some: { userId: session.user.id } } } } };
  const deepLinkWhere = parseDeepLinkWhere(resolvedSearchParams);

  const comments = await prisma.comment.findMany({
    where: { AND: [scopeWhere, deepLinkWhere] },
    orderBy: { createdAt: "desc" },
    include: {
      commenter: { select: { id: true, displayName: true, email: true } },
      thread: {
        select: {
          id: true,
          status: true,
          quotedText: true,
          post: { select: { id: true, slug: true, title: true } },
        },
      },
    },
  });

  // Per-commenter counts, scoped to the same visible set of comments as the
  // table itself (an AUTHOR shouldn't learn a commenter's activity on posts
  // they can't see).
  const counts = new Map<string, { submitted: number; inModeration: number; spam: number }>();
  for (const comment of comments) {
    if (comment.deletedByUserId !== null) continue;
    const entry = counts.get(comment.commenterId) ?? { submitted: 0, inModeration: 0, spam: 0 };
    if (comment.status === "APPROVED") entry.submitted++;
    else if (comment.status === "PENDING") entry.inModeration++;
    else if (comment.status === "SPAM") entry.spam++;
    counts.set(comment.commenterId, entry);
  }

  const rows = comments.map((comment) => {
    const commenterCounts = counts.get(comment.commenterId) ?? { submitted: 0, inModeration: 0, spam: 0 };
    return {
      id: comment.id,
      postId: comment.thread.post.id,
      postSlug: comment.thread.post.slug,
      postTitle: comment.thread.post.title,
      commenterId: comment.commenterId,
      commenterName: comment.commenter.displayName,
      commenterEmail: comment.commenter.email,
      bodyText: (comment.body as { text?: string } | null)?.text ?? "",
      status: comment.status,
      threadStatus: comment.thread.status,
      createdAt: comment.createdAt,
      statusChangedAt: comment.statusChangedAt,
      deleted: comment.deletedByUserId !== null,
      commenterCounts,
    };
  });

  return (
    <main style={{ maxWidth: 1200, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Comments</h1>
      <CommentsTable rows={rows} />
    </main>
  );
}
