import type { Metadata } from "next";
import SignInForm from "./sign-in-form";
import { safeCallbackUrl } from "@/lib/sign-in-redirect";

export const metadata: Metadata = { title: "Sign in" };

// Server component so the failed-sign-in message survives a no-JavaScript POST,
// which lands here as a fresh document load carrying `?error=1` (see
// `signInAction`). Reading it with `useSearchParams()` in the client component
// instead would leave that message permanently invisible to exactly the users
// this path exists for. Same page/form split as /reset-password.
//
// `callbackUrl` is validated here rather than in the form, for the same reason:
// it has to survive the no-JS round trip, and the client component may never
// run. What reaches `SignInForm` is a known-safe same-origin path or null, so
// neither the client navigation nor the hidden field can carry an open redirect
// (src/lib/sign-in-redirect.ts). Null rather than a defaulted "/dashboard" so
// the ordinary case renders no hidden field and a failed no-JS attempt doesn't
// echo a destination nobody asked for back into the URL.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string | string[] }>;
}) {
  const { error, callbackUrl } = await searchParams;
  return (
    <SignInForm
      initialError={error ? "Invalid email or password." : null}
      callbackUrl={safeCallbackUrl(callbackUrl)}
    />
  );
}
