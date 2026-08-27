import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canEditAnyPost } from "@/lib/authz";

export const metadata: Metadata = { title: "History" };

// PLAN.md §15 — a post's history is now its publish/schedule/unpublish
// events, not a list of independently-saved revisions: there's nothing to
// list between publishes, since editing happens on the doc instead.
export default async function PostHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  const post = await prisma.post.findUnique({
    where: { id },
    include: {
      authors: { select: { userId: true } },
      publicationEvents: {
        orderBy: { createdAt: "desc" },
        include: { actor: { select: { name: true, email: true } }, doc: { select: { title: true, slug: true } } },
      },
    },
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

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>History: {post.title}</h1>
      <p>
        <Link href={`/posts/${post.id}/edit`}>Back to editor</Link>
      </p>
      {post.publicationEvents.length === 0 ? (
        <p style={{ color: "var(--text-secondary)" }}>No publish activity yet.</p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0 }}>
          {post.publicationEvents.map((event) => (
            <li key={event.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              {event.proseJson ? (
                <Link href={`/posts/${post.id}/history/${event.id}`}>
                  {event.type} — {event.title}
                </Link>
              ) : (
                <span>{event.type}</span>
              )}{" "}
              {event.id === post.publishEventId && <strong style={{ color: "var(--success)" }}>(current)</strong>}
              <div style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>
                {event.createdAt.toLocaleString()} by{" "}
                {event.actor?.name ?? event.actor?.email ?? "system"}
                {event.doc && ` — from doc “${event.doc.title || "Untitled"}”`}
                {event.scheduledFor && ` — scheduled for ${event.scheduledFor.toLocaleString()}`}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
