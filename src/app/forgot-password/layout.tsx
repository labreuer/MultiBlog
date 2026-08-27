import type { Metadata } from "next";

// "use client" page, so the title lives here rather than beside the form —
// see /sign-up/layout.tsx.
export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
