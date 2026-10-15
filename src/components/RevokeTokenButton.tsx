"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { revokeApiToken } from "@/app/actions/api-tokens";

// Revoke on /dashboard's Connections card (docs/MCP.md §21, "Seeing and
// ending a connection"). A revoked token never comes back — a connection is
// made again on the consent page, a header token issued again by the script —
// so it takes the inline two-step confirm /users' Send invite uses.
export default function RevokeTokenButton({ tokenId, name }: { tokenId: string; name: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function revoke() {
    setConfirming(false);
    setError(null);
    startTransition(async () => {
      try {
        await revokeApiToken(tokenId);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to revoke.");
      }
    });
  }

  if (confirming) {
    return (
      <span style={{ color: "var(--text-secondary)" }}>
        Revoke {name}?{" "}
        <button type="button" onClick={revoke} disabled={pending} style={{ fontWeight: "bold", color: "var(--success)" }}>
          Yes
        </button>{" "}
        /{" "}
        <button type="button" onClick={() => setConfirming(false)} disabled={pending} style={{ fontWeight: "bold", color: "var(--danger)" }}>
          No
        </button>
      </span>
    );
  }

  return (
    <>
      <button type="button" onClick={() => setConfirming(true)} disabled={pending}>
        {pending ? "Revoking…" : "Revoke"}
      </button>
      {error && (
        <span role="alert" style={{ display: "block", color: "var(--danger)", fontSize: "0.8rem" }}>
          {error}
        </span>
      )}
    </>
  );
}
