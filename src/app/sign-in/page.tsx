import SignInForm from "./sign-in-form";

// Server component so the failed-sign-in message survives a no-JavaScript POST,
// which lands here as a fresh document load carrying `?error=1` (see
// `signInAction`). Reading it with `useSearchParams()` in the client component
// instead would leave that message permanently invisible to exactly the users
// this path exists for. Same page/form split as /reset-password.
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  return <SignInForm initialError={error ? "Invalid email or password." : null} />;
}
