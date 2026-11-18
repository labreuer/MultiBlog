import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { renderToReactElement } from "@tiptap/static-renderer";
import { auth } from "@/lib/auth";
import { contentExtensions } from "@/lib/tiptap-schema";
import { heldCommonsPageBody, WELCOME_PAGE_NAME } from "@/lib/front-page";
import { displayNameOf } from "@/lib/display-name";
import { signInPath } from "@/lib/sign-in-redirect";
import prose from "@/styles/prose.module.css";

export const metadata: Metadata = { title: "Welcome" };

// docs/EMAIL.md §10, "The welcome page" — the commons page `New Account
// Welcome`, for any signed-in viewer, under a greeting. Found as the front
// page is, but asked of the wiki read rule for *this* viewer, so it shows
// exactly when they could read the page at its address. A join card's
// confirmation links its first sign-in here; nothing records a visit. The
// body goes through docJsonForPostSide (heldCommonsPageBody), so a mention or
// a citation in it renders as text.
export default async function WelcomePage() {
  const session = await auth();
  if (!session?.user) redirect(signInPath("/welcome"));

  const body = await heldCommonsPageBody(WELCOME_PAGE_NAME, { id: session.user.id, role: session.user.role });

  return (
    <main style={{ maxWidth: 800, margin: "3rem auto", padding: "0 1rem" }}>
      <h1>Welcome, {displayNameOf(session.user)}</h1>
      {body ? (
        <div className={prose.prose} style={{ marginTop: "1.5rem" }}>
          {renderToReactElement({ content: body, extensions: contentExtensions })}
        </div>
      ) : (
        <p style={{ marginTop: "1rem" }}>There&apos;s no welcome page here yet.</p>
      )}
      <p style={{ marginTop: "2rem" }}>
        <Link href="/dashboard">Go to your dashboard</Link>
      </p>
    </main>
  );
}
