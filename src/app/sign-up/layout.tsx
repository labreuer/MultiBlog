import type { Metadata } from "next";

// The page itself is "use client" (useActionState), and a client component
// can't export metadata — so the title lives in a layout beside it. Same
// arrangement as /forgot-password.
export const metadata: Metadata = { title: "Create account" };

export default function SignUpLayout({ children }: { children: React.ReactNode }) {
  return children;
}
