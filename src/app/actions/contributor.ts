"use server";

import { revalidatePath } from "next/cache";
import type { JSONContent } from "@tiptap/core";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { pmBlurbSchema } from "@/lib/tiptap-schema";
import { extractText } from "@/lib/diff";
import { normalizeOrcid, normalizeWebsite } from "@/lib/contributor-links";
import { storeAvatar, MAX_UPLOAD_BYTES } from "@/lib/avatar";
import { avatarUrl } from "@/lib/avatar-url";
import type { Prisma } from "@/generated/prisma/client";

const MAX_BLURB_CHARS = 500;

// Resolves the signed-in user from the session — never from a client-
// supplied id — and re-reads isListedContributor from the database rather
// than trusting that the panel was only rendered when it was true (PLAN.md
// §17g). The dashboard's own render gate can go stale the moment an admin
// flips the flag in another tab; this is the actual enforcement.
async function requireListedContributor(): Promise<string> {
  const session = await auth();
  if (!session?.user) {
    throw new Error("You must be signed in.");
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { isListedContributor: true },
  });
  if (!user?.isListedContributor) {
    throw new Error("You aren't a listed contributor.");
  }
  return session.user.id;
}

// Throws on any node/mark blurbExtensions doesn't define — the schema *is*
// the validation (PLAN.md §17f), not an HTML allowlist. Also caps extracted
// text length, so nobody pastes an essay into a 280px sidebar column.
function validateBlurb(blurb: JSONContent): Prisma.InputJsonValue {
  const node = pmBlurbSchema.nodeFromJSON(blurb);
  if (extractText(node.toJSON()).length > MAX_BLURB_CHARS) {
    throw new Error(`Blurb is too long (max ${MAX_BLURB_CHARS} characters).`);
  }
  return node.toJSON() as Prisma.InputJsonValue;
}

export type ContributorProfileInput = {
  blurb: JSONContent;
  order: string;
  orcid: string;
  website: string;
};

// One combined write for the whole panel (PLAN.md §17f/§17g) rather than a
// per-field autosave — the blurb editor has no live session to debounce
// into, so there's no mechanism an autosave would even be reusing.
export async function updateContributorProfile(input: ContributorProfileInput): Promise<void> {
  const userId = await requireListedContributor();

  const trimmedOrcid = input.orcid.trim();
  const orcid = trimmedOrcid ? normalizeOrcid(trimmedOrcid) : null;
  if (trimmedOrcid && !orcid) {
    throw new Error("Invalid ORCID iD.");
  }

  const trimmedWebsite = input.website.trim();
  const website = trimmedWebsite ? normalizeWebsite(trimmedWebsite) : null;
  if (trimmedWebsite && !website) {
    throw new Error("Website must be a valid http(s) URL.");
  }

  const trimmedOrder = input.order.trim();
  let order: number | null = null;
  if (trimmedOrder) {
    order = Number(trimmedOrder);
    if (!Number.isInteger(order)) {
      throw new Error("Order must be a whole number.");
    }
  }

  const blurb = validateBlurb(input.blurb);

  await prisma.user.update({
    where: { id: userId },
    data: {
      contributorBlurb: blurb,
      contributorOrder: order,
      orcid,
      website,
    },
  });
  revalidatePath("/");
  revalidatePath("/dashboard");
}

// The avatar is its own action rather than a field on the combined Save
// above (PLAN.md §17n): it carries binary in a FormData, it applies
// immediately rather than waiting for a Save the user might not press, and
// its failure modes ("that isn't an image", "too large") are entirely its
// own. Returns the new src so the panel can repoint its preview without a
// round trip through the server component.
//
// Note there is no "avatar from URL" path, deliberately: having the *server*
// fetch a user-supplied URL is textbook SSRF (internal addresses, cloud
// metadata endpoints). Today the only URL fetch in this feature is the
// sample-data seed's, against hardcoded constants. A remote `User.image`
// still renders as a fallback, but the browser fetches that, not us.
export async function uploadContributorAvatar(formData: FormData): Promise<{ src: string }> {
  const userId = await requireListedContributor();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    throw new Error("No file was selected.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`Image is too large (max ${Math.floor(MAX_UPLOAD_BYTES / 1024 / 1024)}MB).`);
  }

  // The declared type is never trusted — processAvatar sniffs the real
  // format by decoding — but rejecting an obviously-wrong one first gives a
  // clearer message than sharp's decode failure would.
  if (file.type && !file.type.startsWith("image/")) {
    throw new Error("That file isn't an image.");
  }

  const { hash } = await storeAvatar(userId, new Uint8Array(await file.arrayBuffer()));
  revalidatePath("/");
  revalidatePath("/dashboard");
  return { src: avatarUrl(userId, hash) };
}

export async function removeContributorAvatar(): Promise<void> {
  const userId = await requireListedContributor();
  // deleteMany, not delete: removing an avatar that isn't there should be a
  // no-op, not a P2025 the panel has to special-case.
  await prisma.userAvatar.deleteMany({ where: { userId } });
  revalidatePath("/");
  revalidatePath("/dashboard");
}

// The only path back to false — updateUserIsListedContributor (actions/
// users.ts, admin-gated) is the only path to true. Without that asymmetry
// the confirm dialog in ContributorPanel is theatre: anyone who had ever
// been listed could put themselves back on the public front page at will
// (PLAN.md §17g/§17h).
export async function optOutAsContributor(): Promise<void> {
  const userId = await requireListedContributor();
  await prisma.user.update({ where: { id: userId }, data: { isListedContributor: false } });
  revalidatePath("/");
  revalidatePath("/dashboard");
}
