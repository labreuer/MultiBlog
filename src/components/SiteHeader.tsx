import Link from "next/link";
import { auth } from "@/lib/auth";

export default async function SiteHeader() {
  const session = await auth();

  return (
    <header
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "1rem",
        borderBottom: "1px solid #ddd",
      }}
    >
      <Link href="/" style={{ fontWeight: "bold", textDecoration: "none", color: "inherit" }}>
        MultiBlog
      </Link>
      <nav>
        {session?.user ? (
          <Link href="/dashboard">Dashboard</Link>
        ) : (
          <>
            <Link href="/sign-in">Sign in</Link> · <Link href="/sign-up">Sign up</Link>
          </>
        )}
      </nav>
    </header>
  );
}
