"use server";

import { revalidatePath } from "next/cache";
import type { JSONContent } from "@tiptap/core";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { pmBlurbSchema } from "@/lib/tiptap-schema";
import { extractText } from "@/lib/diff";
import { normalizeOrcid, normalizeWebsite } from "@/lib/contributor-links";
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
  image: string;
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

  const trimmedImage = input.image.trim();
  if (trimmedImage && !normalizeWebsite(trimmedImage)) {
    throw new Error("Image URL must be a valid http(s) URL.");
  }

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
      image: trimmedImage || null,
      contributorBlurb: blurb,
      contributorOrder: order,
      orcid,
      website,
    },
  });
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
