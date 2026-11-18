"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { AccountRefusal, createPasswordAccountAlone } from "@/lib/accounts";
import { signInAfterSignUpPath } from "@/lib/sign-in-redirect";

export type SignUpState = { error?: string };

// The account is made by createPasswordAccount (src/lib/accounts.ts), as a
// join card's is: the email stored trimmed, and refused when any account has
// it in any case.
export async function signUp(_prevState: SignUpState, formData: FormData): Promise<SignUpState> {
  const email = formData.get("email");
  const name = formData.get("name");
  const password = formData.get("password");

  if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
    return { error: "Email and password are required." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  try {
    await createPasswordAccountAlone({
      email,
      name: typeof name === "string" ? name : null,
      passwordHash: await bcrypt.hash(password, 12),
    });
  } catch (err) {
    if (err instanceof AccountRefusal) return { error: err.message };
    throw err;
  }

  redirect(signInAfterSignUpPath());
}
