"use server";

import { revalidatePath } from "next/cache";
import { actorFromSessionUser } from "@/lib/actor";
import { revokeToken } from "@/lib/api/token-card";
import { auth } from "@/lib/auth";

// /dashboard's Connections card (docs/MCP.md §21, "Seeing and ending a
// connection"). The rule, that only a token's issuer or its account may
// revoke it, is src/lib/api/token-card.ts's; this adds the session.
export async function revokeApiToken(tokenId: string): Promise<void> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("You must be signed in.");
  }
  await revokeToken(actorFromSessionUser(session.user), String(tokenId));
  revalidatePath("/dashboard");
}
