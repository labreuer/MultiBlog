import { auth } from "@/lib/auth";
import { wikiNamespacesFor } from "@/lib/wiki-create";
import CreateOffer from "./create-offer";
import styles from "../wiki.module.css";

// docs/WIKI.md "Requests and responses" — what notFound() renders anywhere
// under /wiki/<owner>: the namespace list, a page, its editor, a sub-path.
// Next gives this file no props, so it isn't told which address missed: the
// server half works out where this viewer may create, by the tests creating
// applies; the client half reads the path. The status is a 404 only while
// notFound() runs before anything streams, so nothing under src/app has a
// loading.tsx (the e2e case asserts the status, to catch one being added).
export default async function WikiNotFound() {
  const session = await auth();
  const namespaces = session?.user ? await wikiNamespacesFor(session.user) : null;
  return (
    <main className={styles.main}>
      <h1>Not found</h1>
      <p className={styles.intro}>There&apos;s nothing here.</p>
      {namespaces && (namespaces.person || namespaces.commons) && (
        <CreateOffer personSlug={namespaces.person?.slug ?? null} commons={namespaces.commons} />
      )}
    </main>
  );
}
