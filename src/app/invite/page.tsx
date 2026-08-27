import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import { findLiveInvite } from "@/lib/invite";
import InviteForm from "./invite-form";

export const metadata: Metadata = { title: "Accept invite" };

export default async function InvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const invite = token ? await findLiveInvite(token) : null;

  // Stamped here, on the GET that renders this page — including a corporate
  // mail scanner's prefetch, which is fine: that still proves the message
  // was deliverable, which is all "clicked" claims to mean (docs/EMAIL.md).
  // Idempotent via clickedAt: null in the where, so a reload or back button
  // doesn't re-stamp or error.
  if (invite && !invite.clickedAt) {
    await prisma.userInvite.updateMany({
      where: { id: invite.id, clickedAt: null },
      data: { clickedAt: new Date() },
    });
  }

  return <InviteForm token={token ?? ""} email={invite?.user.email ?? null} />;
}
