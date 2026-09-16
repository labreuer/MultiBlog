"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { canEditAnyPost } from "@/lib/role-checks";

// PLAN.md §21i — the one logged-in affordance on the public post page:
// "configure post" after the byline's date, linking to /post/[id]/edit, in
// the ordinary link color so it reads as the control it is.
//
// A client island reading useSession(), the same shape as TagStrip and for
// the same reason: the page is statically generated (generateStaticParams +
// revalidate), so reading the session on the server would throw
// DYNAMIC_SERVER_USAGE at build (PLAN.md §12f). SSR and the first client
// render have no session and emit nothing, so a signed-out reader's HTML is
// byte-identical to before; the link appears after hydration, at the end of
// the byline where nothing reflows.
//
// The check is an affordance, not a gate (docs/PERMISSIONS.md): the editor
// route re-asks canUserEditPost on the server, and this mirrors that rule —
// ADMIN/EDITOR edit any post, an AUTHOR only one they are on the byline of.
// The author ids it needs are shipped as a prop, which puts them in the
// page's RSC payload; they are opaque cuids, and the same ids already reach
// the browser wherever a comment or annotation names its author.
export default function PostEditLink({ postId, authorIds }: { postId: string; authorIds: string[] }) {
  const { data: session } = useSession();
  const user = session?.user;
  if (!user) return null;
  const mayEdit = canEditAnyPost(user.role) || (user.role === "AUTHOR" && authorIds.includes(user.id));
  if (!mayEdit) return null;
  return (
    <>
      {" · "}
      <Link href={`/post/${postId}/edit`}>configure post</Link>
    </>
  );
}
