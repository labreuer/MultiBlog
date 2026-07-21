"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { colorForSeed } from "@/lib/author-colors";

export type SignUpState = { error?: string };

function deriveInitials(name: string | null, email: string): string {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 0) {
    const first = words[0][0];
    const last = words.length > 1 ? words[words.length - 1][0] : words[0][1];
    return `${first}${last ?? ""}`.toUpperCase();
  }
  return email.slice(0, 2).toUpperCase();
}

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

  const existing = await prismaIncludingDeleted.user.findUnique({ where: { email } });
  if (existing) {
    return { error: "An account with that email already exists." };
  }

  const trimmedName = typeof name === "string" && name ? name : null;
  const passwordHash = await bcrypt.hash(password, 12);
  await prismaIncludingDeleted.user.create({
    data: {
      email,
      name: trimmedName,
      passwordHash,
      color: colorForSeed(email),
      adminInitials: deriveInitials(trimmedName, email),
    },
  });

  redirect("/sign-in?registered=1");
}
