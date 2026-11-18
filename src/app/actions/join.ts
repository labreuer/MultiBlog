"use server";

import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { getClientIp } from "@/lib/request-ip";
import { normalizeJoinCode } from "@/lib/join-codes/code";
import { claimJoinCode, confirmJoinClaim, type ClaimResult, type ConfirmResult } from "@/lib/join-codes/cards";

// docs/EMAIL.md §10, "The card holder's path": the three POSTs a card holder
// makes. Each is a thin wrapper over src/lib/join-codes/cards.ts, which holds
// every rule; these add the session and the request's IP address.

export type EnterCodeState = { error?: string };

/** `/join`'s typed code, normalized and sent to its card's page; nothing is looked up here. */
export async function enterJoinCode(_prev: EnterCodeState, formData: FormData): Promise<EnterCodeState> {
  const raw = formData.get("code");
  const code = typeof raw === "string" ? normalizeJoinCode(raw) : null;
  if (!code) return { error: "That isn't a card's code. It is 16 letters and digits, as printed under the QR." };
  redirect(`/join/${code}`);
}

/** The name and email go back with a refusal, so the form keeps them; the password never does. */
export type ClaimState = { result?: ClaimResult; name?: string; email?: string };

export async function claimJoinCard(_prev: ClaimState, formData: FormData): Promise<ClaimState> {
  const field = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  const session = await auth();
  const result = await claimJoinCode({
    code: field("code"),
    name: field("name"),
    email: field("email"),
    password: field("password"),
    ipAddress: await getClientIp(),
    signedIn: !!session?.user,
  });
  return { result, name: field("name"), email: field("email") };
}

export type ConfirmState = { result?: ConfirmResult };

export async function confirmJoinCard(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const token = formData.get("token");
  const password = formData.get("password");
  const result = await confirmJoinClaim({
    token: typeof token === "string" ? token : "",
    password: typeof password === "string" ? password : "",
    ipAddress: await getClientIp(),
  });
  return { result };
}
