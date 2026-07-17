"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { moderateComment } from "@/app/actions/comments";

export default function ModerateCommentButtons({ commentId }: { commentId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handle = (action: "approve" | "spam") => {
    setError(null);
    startTransition(async () => {
      try {
        await moderateComment(commentId, action);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to moderate comment.");
      }
    });
  };

  return (
    <div>
      <button type="button" onClick={() => handle("approve")} disabled={pending}>
        Approve
      </button>{" "}
      <button type="button" onClick={() => handle("spam")} disabled={pending}>
        Mark as spam
      </button>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </div>
  );
}
