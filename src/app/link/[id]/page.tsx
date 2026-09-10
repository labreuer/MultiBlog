import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { gated, titleWhenOk } from "@/lib/route-access";
import { anchoredLinkLandingFor } from "@/lib/anchored-link-data";
import { UNNAMED_LINK_TITLE, anchoredLinkTitle } from "@/lib/anchored-link-name";
import { pathWithQuery, signInPath } from "@/lib/sign-in-redirect";
import AnchoredLinkHeading from "@/components/anchored-link/AnchoredLinkHeading";
import AnchoredLinkTray from "@/components/anchored-link/AnchoredLinkTray";
import EditLinkButton from "@/components/anchored-link/EditLinkButton";
import styles from "./page.module.css";

// docs/ANCHORED_LINKS.md, "The landing route" — the URL a minted link hands
// out. A router before it is a page: when this viewer may read exactly one
// of the link's targets there is only one honest place to go, and the route
// sends them there with ?sel= (the reading surface scrolls, highlights and
// lists the parts itself). Otherwise — several readable targets, or none —
// it renders the link's passages as excerpts from the stored quotes, each
// group with a way into its surface. `?noredirect=1` always renders the
// excerpt page; the banner's "View as excerpts" link is how a reading page
// offers it.
//
// Why the URL moved here from part 0's page: the minted href used to be
// chosen once, by whoever minted it, but readability is per viewer — a
// recipient who could not read part 0's doc met that doc's Forbidden and
// never learned the link had a PDF part they could see. Routing at follow
// time, per viewer, is what closes that.
//
// Excerpts are the stored `quoted_text`, plain: the doc side flattens a
// paragraph break to a space and the PDF side is normalised text — thinner
// than the passage, and honest about being what the anchor holds. Nothing
// here opens a ydoc, mounts an editor or touches pdfjs, which is the point
// of the page: it is the fast path on a phone, and the only one when a
// target is heavy or gone. Per-user gated, so dynamic, like /doc/[slug].

// A named link's heading and tab title are its name (docs/ANCHORED_LINKS.md,
// "Naming a link"); the generic title stays for an unnamed one, and for the
// "nothing readable" page, which names nothing about the link on purpose.
const PAGE_TITLE = UNNAMED_LINK_TITLE;

// "not-found" covers a deleted link and someone else's draft as well as a
// bad id — the loader's own existence rule. There is no "forbidden" arm:
// an unreadable *target* is a group omitted, never a page refused.
const loadLink = gated(async (user, id: string) => {
  const landing = await anchoredLinkLandingFor(id, user);
  if (landing.status === "not-found") return "not-found";
  return landing;
});

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  return titleWhenOk(await loadLink(id), (landing) =>
    landing.status === "ok" ? anchoredLinkTitle(landing.link.name) : PAGE_TITLE,
  );
}

export default async function AnchoredLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ noredirect?: string }>;
}) {
  const { id } = await params;
  const { noredirect } = await searchParams;
  const stay = noredirect === "1";
  // Free — generateMetadata already ran this for the same request.
  const access = await loadLink(id);
  if (access.status === "signed-out") {
    // Keeps ?noredirect=: sign-in must return to the page that was asked
    // for, not to the redirect it declined.
    redirect(signInPath(pathWithQuery(`/link/${id}`, new URLSearchParams(stay ? { noredirect: "1" } : {}))));
  }
  if (access.status !== "ok") {
    notFound();
  }
  const landing = access.value;

  if (landing.status === "nothing-readable") {
    // Acknowledges the link — the viewer holds its id already — and nothing
    // about what it points at: not a count, not a kind (docs/PERMISSIONS.md).
    return (
      <main className={styles.container} data-testid="anchored-link-landing">
        <h1 className={styles.title}>{PAGE_TITLE}</h1>
        <p className={styles.empty}>This link has no passages you have permission to read.</p>
      </main>
    );
  }

  const { link, createdBy, mintedAt, editedAt } = landing;
  if (!stay && link.groups.length === 1) {
    redirect(link.groups[0].href);
  }

  // /side-by-side takes exactly two docs and forbids the pair if either is
  // unreadable; both groups here passed the same predicate, so the offer is
  // honest. Hidden by CSS below the width where that layout stacks.
  const docPair =
    link.groups.length === 2 && link.groups.every((group) => group.target.kind === "doc")
      ? `/side-by-side/${link.groups[0].target.id}/${link.groups[1].target.id}`
      : null;

  return (
    <main className={styles.container} data-testid="anchored-link-landing">
      <AnchoredLinkHeading linkId={link.id} name={link.name} className={styles.title} />
      <p className={styles.meta}>
        {/* A Server Component: toLocaleDateString here is formatted once and
            shipped as a string (CLAUDE.md's Gotchas). */}
        {mintedAt ? (
          <>
            Shared by {createdBy.name ?? "someone"} on {mintedAt.toLocaleDateString()}
            {editedAt && <>, edited {editedAt.toLocaleDateString()}</>}.{" "}
          </>
        ) : (
          <>Your draft link. </>
        )}
        Quotes are as captured when each passage was added.
      </p>
      {/* docs/ANCHORED_LINKS.md, "Editing a minted link" — the creator's way
          into the tray from here. The tray itself is mounted below, so a
          reopened link is edited on this page too: remove, reorder, Done;
          adding a passage means "Open in context" on one of the groups. */}
      {link.canEdit && (
        <p className={styles.edit}>
          <EditLinkButton linkId={link.id} />
        </p>
      )}
      {docPair && (
        <p className={styles.sideBySide}>
          <Link href={docPair}>Open side by side</Link>
        </p>
      )}
      {link.groups.map((group) => (
        <section
          key={`${group.target.kind}:${group.target.id}`}
          className={styles.group}
          data-testid="anchored-link-group"
        >
          <h2 className={styles.groupTitle}>
            <span className={styles.kind}>{group.target.kind === "doc" ? "Doc" : "PDF"}</span>
            {group.label}
          </h2>
          <ol className={styles.parts}>
            {group.parts.map((part) => (
              <li key={part.anchorId}>
                <blockquote className={styles.quote}>{part.quotedText}</blockquote>
              </li>
            ))}
          </ol>
          <p className={styles.open}>
            <Link href={group.href}>Open in context</Link>
          </p>
        </section>
      ))}
      <AnchoredLinkTray />
    </main>
  );
}
