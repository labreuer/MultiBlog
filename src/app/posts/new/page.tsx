import { redirect } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { editableDocsFor } from "@/lib/doc-authz";
import { signInPath } from "@/lib/sign-in-redirect";
import NewPostDocPicker from "@/components/NewPostDocPicker";

export const metadata: Metadata = { title: "New post" };

// PLAN.md §15d — a post is created from a doc, not typed from scratch: the
// content always starts as that doc's current state. editableDocsFor mirrors
// canUserEditDoc as a `where` clause, so only docs this user could actually
// publish from ever show up here.
export default async function NewPostPage() {
  const session = await auth();
  if (!session?.user) {
    redirect(signInPath("/posts/new"));
  }

  const docs = await editableDocsFor(session.user.id, session.user.role);

  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>New post</h1>
      {docs.length === 0 ? (
        <p>
          You don&apos;t have an editable doc to publish from yet. <Link href="/docs">Create one</Link> first.
        </p>
      ) : (
        <NewPostDocPicker docs={docs} />
      )}
      <p>
        <Link href="/posts">Back to posts</Link>
      </p>
    </main>
  );
}
