import { lookupJoinClaim } from "@/lib/join-codes/cards";
import styles from "@/styles/account.module.css";
import ConfirmForm from "./confirm-form";

export const metadata = { title: "Confirm your email" };

// docs/EMAIL.md §10, "The card holder's path", step 5. **This GET changes
// nothing**: a corporate mail scanner fetches every link in a message, and a
// GET that confirmed would confirm an email someone else typed. The form's
// POST confirms, and asks for the password chosen at the scan.
export default async function JoinConfirmPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  const claim = typeof token === "string" ? await lookupJoinClaim(token) : null;
  if (!claim) {
    return (
      <main className={styles.main}>
        <div className={styles.card}>
          <h1>This link can&apos;t be used</h1>
          <p>
            It may be older than seven days, or the card was scanned again since, or it has been used. Scan the card
            again to get a new link.
          </p>
        </div>
      </main>
    );
  }
  return <ConfirmForm token={token!} email={claim.email} />;
}
