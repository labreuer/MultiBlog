import Link from "next/link";
import { redirect } from "next/navigation";
import type { JSONContent } from "@tiptap/core";
import { auth, signOut } from "@/lib/auth";
import { canManagePosts, isAdmin } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import SessionRefresh from "@/components/SessionRefresh";
import ContributorPanel from "@/components/ContributorPanel";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

  // isListedContributor gates ContributorPanel below. Read from the
  // database, not the session: the JWT bakes in id/role/color at sign-in
  // and never re-reads (src/app/sign-in/NOTES.md), so a freshly-listed
  // contributor would otherwise not see their own panel until the token
  // turned over (PLAN.md §17g).
  const contributor = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      name: true,
      slug: true,
      color: true,
      adminInitials: true,
      isListedContributor: true,
      image: true,
      contributorBlurb: true,
      contributorOrder: true,
      orcid: true,
      website: true,
    },
  });

  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
      {/* Pulls role/name/color back from the DB into the JWT on every visit, so
          a promotion doesn't wait for a sign-out. This first render can still
          show the pre-refresh values for a beat; the router.refresh() it fires
          corrects them. */}
      <SessionRefresh />
      <h1>Dashboard</h1>
      <p>Signed in as {session.user.email}</p>
      <p>Role: {session.user.role}</p>
      {canManagePosts(session.user.role) && (
        <p>
          <Link href="/posts">Manage posts</Link>
        </p>
      )}
      {canManagePosts(session.user.role) && (
        <p>
          <Link href="/comments">Manage comments</Link>
        </p>
      )}
      {isAdmin(session.user.role) && (
        <p>
          <Link href="/users">Manage users</Link>
        </p>
      )}
      {contributor && contributor.isListedContributor && (
        <ContributorPanel
          name={contributor.name ?? session.user.email ?? "You"}
          slug={contributor.slug}
          color={contributor.color}
          adminInitials={contributor.adminInitials}
          image={contributor.image}
          contributorBlurb={contributor.contributorBlurb as JSONContent | null}
          contributorOrder={contributor.contributorOrder}
          orcid={contributor.orcid}
          website={contributor.website}
        />
      )}
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
      >
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
