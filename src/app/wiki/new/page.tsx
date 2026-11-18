import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { signInPath } from "@/lib/sign-in-redirect";
import { searchOf } from "@/lib/wiki-pages";
import { wikiNamespacesFor } from "@/lib/wiki-create";
import NewWikiPageForm from "./new-page-form";
import styles from "../wiki.module.css";

export const metadata: Metadata = { title: "New wiki page" };

// docs/WIKI.md "Creating a page" — /wiki/new, for whoever may create
// somewhere: their own namespace, or the commons for an ADMIN or EDITOR.
// The 404's offer opens it with the missing address filled in, as
// ?where=&name=&variant=.
export default async function NewWikiPageRoute({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const session = await auth();
  if (!session?.user) redirect(signInPath(`/wiki/new${searchOf(query)}`));
  const namespaces = await wikiNamespacesFor(session.user);
  if (!namespaces.person && !namespaces.commons) {
    return (
      <main className={styles.main}>
        <h1>Forbidden</h1>
        <p>You can&apos;t create a wiki page. {namespaces.personRefusal}</p>
      </main>
    );
  }
  const text = (key: string) => (typeof query[key] === "string" ? (query[key] as string) : "");
  const where = text("where") === "commons" && namespaces.commons ? "commons" : namespaces.person ? "person" : "commons";
  return (
    <main className={styles.main}>
      <h1>New wiki page</h1>
      <NewWikiPageForm
        viewerId={session.user.id}
        person={namespaces.person && { id: namespaces.person.id, slug: namespaces.person.slug }}
        personRefusal={namespaces.personRefusal}
        commons={namespaces.commons}
        initial={{ where, name: text("name"), variant: text("variant") }}
      />
    </main>
  );
}
