import Link from "next/link";

// `em` (not `rem`): half the size of whichever heading this sits inside
// (h1 on the single-post page, h2 in listings) — `rem` would instead track
// the root/site-header size, which is smaller than either heading, so
// "half of root" ends up as a quarter (or a third) of the actual title
// text it's next to. `verticalAlign: middle` counters the default baseline
// alignment, which otherwise sits this much-smaller text low in the line
// instead of centered against the title's full height.
export default function PostEditBadge({ postId, hasPendingEdits }: { postId: string; hasPendingEdits: boolean }) {
  return (
    <Link
      href={`/posts/${postId}/edit`}
      style={{ marginLeft: "3em", fontSize: "0.5em", verticalAlign: "middle" }}
    >
      ({hasPendingEdits ? "edited" : "edit"})
    </Link>
  );
}
