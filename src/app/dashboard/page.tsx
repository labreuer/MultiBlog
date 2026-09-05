import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import type { JSONContent } from "@tiptap/core";
import { auth, signOut } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { canManageDocs } from "@/lib/doc-authz";
import { canEditAuthorIdentity, canViewAuthorColorRoster, COLOR_ROSTER_ROLES } from "@/lib/authz";
import { resolveAvatarSrc } from "@/lib/avatar-url";
import { docTitleOrFallback } from "@/lib/doc-title";
import SessionRefresh from "@/components/SessionRefresh";
import LocalTime from "@/components/LocalTime";
import ContributorPanel from "@/components/ContributorPanel";
import AccountSettings from "@/components/AccountSettings";
import styles from "./page.module.css";
import account from "@/styles/account.module.css";
import { NEUTRAL_THREAD_COLOR } from "@/lib/author-colors";
import { signInPath } from "@/lib/sign-in-redirect";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect(signInPath("/dashboard"));
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
      // Hash only — never the bytes (PLAN.md §17n).
      avatar: { select: { hash: true } },
    },
  });

  // Byline membership doubles as the Edit-link gate; the soft-delete
  // extension already excludes deleted docs. docs/DASHBOARD.md "Recent docs".
  const recentDocs = await prisma.doc.findMany({
    where: { authors: { some: { userId: session.user.id } } },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: {
      id: true,
      slug: true,
      title: true,
      updatedAt: true,
      // The same string_agg of admin_initials the /docs table shows, joined
      // in byline order by the doc_metrics view (§16e).
      metrics: { select: { byline: true } },
    },
  });

  // The EDITOR+ author-color roster (docs/DASHBOARD.md "Settings"). Sorted
  // in JS on the shown label — Prisma orderBy can't interleave named and
  // unnamed users (author-filter.ts's rationale).
  const colorRoster = canViewAuthorColorRoster(session.user.role)
    ? (
        await prisma.user.findMany({
          where: { role: { in: COLOR_ROSTER_ROLES } },
          select: { id: true, name: true, email: true, adminInitials: true, color: true },
        })
      )
        .map((u) => ({ ...u, label: u.name ?? u.email }))
        .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }))
    : null;

  return (
    <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
      {/* Pulls role/name/color back from the DB into the JWT on every visit, so
          a promotion doesn't wait for a sign-out. This first render can still
          show the pre-refresh values for a beat; the router.refresh() it fires
          corrects them. */}
      <SessionRefresh />
      <h1>Dashboard</h1>
      <p>
        Signed in as {session.user.email} ({session.user.role})
      </p>
      <details className={`${account.card} ${styles.card}`} open>
        {/* Links to this section's own where clause on /docs; plain text for
            anyone /docs would bounce. docs/DASHBOARD.md "Section cards". */}
        <summary>
          <h2>
          {contributor && canManageDocs(session.user.role) ? (
            <Link href={`/docs?authors=${contributor.slug}`}>Recent docs</Link>
          ) : (
            "Recent docs"
          )}
          </h2>
        </summary>
        <div className={styles.cardBody}>
        {recentDocs.length === 0 ? (
          <p style={{ color: "var(--text-secondary)" }}>No docs yet.</p>
        ) : (
          <table style={{ borderCollapse: "collapse", width: "100%", marginTop: "0.5rem" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "0.25rem 1rem 0.25rem 0", borderBottom: "1px solid var(--border-subtle)" }}>Title</th>
                <th style={{ textAlign: "left", padding: "0.25rem 1rem 0.25rem 0", borderBottom: "1px solid var(--border-subtle)" }}>Edit</th>
                <th style={{ textAlign: "left", padding: "0.25rem 1rem 0.25rem 0", borderBottom: "1px solid var(--border-subtle)" }}>Author(s)</th>
                <th style={{ textAlign: "left", padding: "0.25rem 1rem 0.25rem 0", borderBottom: "1px solid var(--border-subtle)" }}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {recentDocs.map((doc) => (
                <tr key={doc.id}>
                  <td style={{ textAlign: "left", padding: "0.25rem 1rem 0.25rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                    <Link href={`/doc/${doc.slug}`}>{docTitleOrFallback(doc.title)}</Link>
                  </td>
                  <td style={{ textAlign: "left", padding: "0.25rem 1rem 0.25rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                    <Link href={`/doc/${doc.slug}/edit`}>edit</Link>
                  </td>
                  <td style={{ textAlign: "left", padding: "0.25rem 1rem 0.25rem 0", borderBottom: "1px solid var(--border-subtle)" }}>{doc.metrics?.byline ?? ""}</td>
                  <td style={{ textAlign: "left", padding: "0.25rem 1rem 0.25rem 0", borderBottom: "1px solid var(--border-subtle)" }}>
                    <LocalTime value={doc.updatedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        </div>
      </details>
      <details className={`${account.card} ${styles.card}`}>
        <summary>
          <h2>Settings</h2>
        </summary>
        <div className={styles.cardBody}>
        {/* contributor is null only for a soft-deleted account with a live
            session; the fallback just keeps the picker valid. */}
        <AccountSettings
          name={contributor?.name ?? ""}
          adminInitials={contributor?.adminInitials ?? ""}
          color={contributor?.color ?? NEUTRAL_THREAD_COLOR}
          canEditAuthorIdentity={canEditAuthorIdentity(session.user.role)}
        />
        {colorRoster && (
          <div style={{ marginTop: "1rem" }}>
            <h3>Author colors</h3>
            {colorRoster.map((u) => (
              <p key={u.id} style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.25rem" }}>
                <span
                  aria-hidden
                  style={{
                    display: "inline-block",
                    width: 16,
                    height: 16,
                    backgroundColor: u.color,
                    border: "1px solid var(--border)",
                    borderRadius: 3,
                  }}
                />
                {u.label}
                <span style={{ color: "var(--text-secondary)" }}>({u.adminInitials})</span>
              </p>
            ))}
          </div>
        )}
        </div>
      </details>
      {contributor && contributor.isListedContributor && (
        <details className={`${account.card} ${styles.card}`}>
          <summary>
            <h2>Contributor profile</h2>
          </summary>
          <div className={styles.cardBody}>
            <ContributorPanel
              name={contributor.name ?? session.user.email ?? "You"}
              slug={contributor.slug}
              color={contributor.color}
              adminInitials={contributor.adminInitials}
              avatarSrc={resolveAvatarSrc({
                userId: session.user.id,
                avatarHash: contributor.avatar?.hash,
                image: contributor.image,
              })}
              hasUploadedAvatar={contributor.avatar !== null}
              contributorBlurb={contributor.contributorBlurb as JSONContent | null}
              contributorOrder={contributor.contributorOrder}
              orcid={contributor.orcid}
              website={contributor.website}
            />
          </div>
        </details>
      )}
      <form
        action={async () => {
          "use server";
          await signOut({ redirectTo: "/" });
        }}
        style={{ marginTop: "1.5rem" }}
      >
        <button type="submit" className={account.button}>
          Sign out
        </button>
      </form>
    </main>
  );
}
