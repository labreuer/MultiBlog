"use client";

import Link from "next/link";
import { useSession } from "next-auth/react";
import { canEditAnyPost } from "@/lib/role-checks";

type Props = {
  postId: string;
  authorUserIds: string[];
  latestRevisionAt: string | null;
  collabUpdatedAt: string | null;
};

// `em` (not `rem`): half the size of whichever heading this sits inside
// (h1 on the single-post page, h2 in listings) — `rem` would instead track
// the root/site-header size, which is smaller than either heading, so
// "half of root" ends up as a quarter (or a third) of the actual title
// text it's next to. `verticalAlign: middle` counters the default baseline
// alignment, which otherwise sits this much-smaller text low in the line
// instead of centered against the title's full height.
//
// Client-side: canEdit/hasPendingEdits depend on the viewer's session,
// which can't be read server-side on a page using ISR (revalidate) without
// forcing the whole route dynamic — see DEPLOY.md's DYNAMIC_SERVER_USAGE
// note. postId/authorUserIds/latestRevisionAt/collabUpdatedAt are plain
// post data, safe to compute server-side and pass down.
export default function PostEditBadge({ postId, authorUserIds, latestRevisionAt, collabUpdatedAt }: Props) {
  const { data: session } = useSession();
  const user = session?.user;
  if (!user) {
    return null;
  }

  const canEdit = canEditAnyPost(user.role) || authorUserIds.includes(user.id);
  if (!canEdit) {
    return null;
  }

  const hasPendingEdits =
    !!collabUpdatedAt && !!latestRevisionAt && new Date(collabUpdatedAt).getTime() > new Date(latestRevisionAt).getTime();

  return (
    <Link
      href={`/posts/${postId}/edit`}
      style={{ marginLeft: "3em", fontSize: "0.5em", verticalAlign: "middle" }}
    >
      ({hasPendingEdits ? "edited" : "edit"})
    </Link>
  );
}
