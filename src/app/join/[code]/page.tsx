import Link from "next/link";
import { auth } from "@/lib/auth";
import { normalizeJoinCode } from "@/lib/join-codes/code";
import { lookupJoinCard } from "@/lib/join-codes/cards";
import { displayNameOf } from "@/lib/display-name";
import { signInPath } from "@/lib/sign-in-redirect";
import styles from "@/styles/account.module.css";
import ClaimForm from "./claim-form";
import SignOutButton from "./sign-out-button";

// docs/EMAIL.md §10, "The card holder's path", step 1. **This GET writes
// nothing**: QR readers, chat previews and link scanners fetch a URL before
// anyone taps it, so the page only looks the card up and shows the form, and
// the form's POST sends the mail.

function decoded(param: string): string {
  // Next hands a dynamic param over percent-encoded (CLAUDE.md, Gotchas).
  try {
    return decodeURIComponent(param);
  } catch {
    return "";
  }
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className={styles.main}>
      <div className={styles.card}>
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

export default async function JoinCardPage({ params }: { params: Promise<{ code: string }> }) {
  const code = normalizeJoinCode(decoded((await params).code));
  const session = await auth();

  // A card never changes an existing account, so a signed-in viewer gets no
  // form, whatever the card's state.
  if (session?.user) {
    return (
      <Notice title="You're signed in">
        <p>
          You&apos;re signed in as {displayNameOf(session.user)}. A card makes a new account, so it can&apos;t be used
          from this session.
        </p>
        <p style={{ marginTop: "1rem" }}>
          <SignOutButton redirectTo={code ? `/join/${code}` : "/join"} />
        </p>
      </Notice>
    );
  }

  const state = code ? await lookupJoinCard(code) : { kind: "unusable" as const };
  switch (state.kind) {
    case "live":
      return <ClaimForm code={code!} />;
    case "claimed":
      return (
        <Notice title="This card has been used">
          <p>
            Its account has been made. If it&apos;s yours, <Link href={signInPath("/dashboard")}>sign in</Link>.
          </p>
        </Notice>
      );
    case "sends-used":
      return (
        <Notice title="This card can't send more email">
          <p>This card has sent all the email it can. Ask the organizer for another card.</p>
        </Notice>
      );
    case "unusable":
      return (
        <Notice title="This card can no longer be used">
          <p>Ask the organizer for another card.</p>
        </Notice>
      );
  }
}
