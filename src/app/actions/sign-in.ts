"use server";

import { AuthError } from "next-auth";
import { redirect } from "next/navigation";
import { signIn } from "@/lib/auth";

/**
 * The no-JavaScript path for the sign-in form.
 *
 * With JavaScript on, `SignInForm`'s `onSubmit` calls `preventDefault()` and this
 * never runs — the client `signIn` handles it, for the SessionProvider reason in
 * ../sign-in/NOTES.md. This exists so the form still *has* a function `action`,
 * which is what makes React render it as `method="POST"`: a form with only an
 * `onSubmit` handler falls back to the browser default of **GET**, which put the
 * password in the query string (and so in history, the Referer header, and every
 * access log) for anyone with JS disabled.
 *
 * Takes `formData` directly rather than the `(prevState, formData)` shape the
 * sibling actions use with `useActionState` — there's no client state to thread
 * through, since reaching this function at all means the page can't run React.
 * Errors come back as a redirect the server-rendered page reads instead.
 */
export async function signInAction(formData: FormData): Promise<void> {
  try {
    await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirectTo: "/dashboard",
    });
  } catch (err) {
    // `signIn`'s own success path redirects by throwing NEXT_REDIRECT, which is
    // not an AuthError — falling through to the rethrow is what lets it happen.
    if (err instanceof AuthError) {
      // Deliberately just a flag: echoing the submitted email back into the URL
      // would re-introduce a smaller version of the leak this action exists to fix.
      redirect("/sign-in?error=1");
    }
    throw err;
  }
}
