import Link from "next/link";
import { auth } from "@/lib/auth";

export default async function Home() {
  const session = await auth();

  return (
    <main style={{ maxWidth: 480, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>MultiBlog</h1>
      {session?.user ? (
        <p>
          Signed in as {session.user.email}. Go to <Link href="/dashboard">dashboard</Link>.
        </p>
      ) : (
        <p>
          <Link href="/sign-in">Sign in</Link> or <Link href="/sign-up">sign up</Link>.
        </p>
      )}
    </main>
  );
}
