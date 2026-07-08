"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";

export type SignUpState = { error?: string };

export async function signUp(_prevState: SignUpState, formData: FormData): Promise<SignUpState> {
  const email = formData.get("email");
  const name = formData.get("name");
  const password = formData.get("password");

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return { error: "Email and password are required." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return { error: "An account with that email already exists." };
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.create({
    data: {
      email,
      name: typeof name === "string" && name ? name : null,
      passwordHash,
    },
  });

  redirect("/sign-in?registered=1");
}
