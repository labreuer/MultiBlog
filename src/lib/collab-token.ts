import { SignJWT, jwtVerify } from "jose";
import type { Role } from "@/generated/prisma/enums";

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error("AUTH_SECRET is not set.");
  }
  return new TextEncoder().encode(secret);
}

export type CollabTokenPayload = {
  sub: string;
  postId: string;
  role: Role;
};

export async function signCollabToken(payload: CollabTokenPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("2m")
    .sign(getSecret());
}

export async function verifyCollabToken(token: string): Promise<CollabTokenPayload> {
  const { payload } = await jwtVerify(token, getSecret());
  const { sub, postId, role } = payload as Record<string, unknown>;
  if (typeof sub !== "string" || typeof postId !== "string" || typeof role !== "string") {
    throw new Error("Malformed collab token.");
  }
  return { sub, postId, role: role as Role };
}
