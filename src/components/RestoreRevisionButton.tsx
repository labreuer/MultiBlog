"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { restoreRevision } from "@/app/actions/posts";

export default function RestoreRevisionButton({
  postId,
  revisionNumber,
}: {
  postId: string;
  revisionNumber: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleRestore = () => {
    if (!confirm(`Restore revision #${revisionNumber} as a new draft revision?`)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        await restoreRevision(postId, revisionNumber);
        router.push(`/posts/${postId}/edit`);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to restore.");
      }
    });
  };

  return (
    <div>
      <button type="button" onClick={handleRestore} disabled={pending}>
        {pending ? "Restoring..." : `Restore revision #${revisionNumber}`}
      </button>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
    </div>
  );
}
