import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/lib/auth";
import { canManagePosts, isAdmin } from "@/lib/authz";
import SessionRefresh from "@/components/SessionRefresh";

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }

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
