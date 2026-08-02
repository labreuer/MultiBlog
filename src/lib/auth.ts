import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import type { Role } from "@/generated/prisma/enums";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  pages: { signIn: "/sign-in" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== "string" || typeof password !== "string") {
          return null;
        }

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash) {
          return null;
        }

        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
          return null;
        }

        return { id: user.id, email: user.email, name: user.name, role: user.role, color: user.color };
      },
    }),
  ],
  callbacks: {
    jwt: async ({ token, user, trigger }) => {
      if (user) {
        token.id = user.id as string;
        token.role = (user as { role: Role }).role;
        token.color = (user as { color: string }).color;
        return token;
      }

      // Re-read the row so a role (or name/color) change made after sign-in
      // reaches an already-issued JWT — see src/app/sign-in/NOTES.md. Fires on
      // any POST to /api/auth/session; today the only caller is
      // <SessionRefresh /> on /dashboard.
      if (trigger === "update" && token.id) {
        const fresh = await prisma.user.findUnique({
          where: { id: token.id },
          select: { name: true, email: true, role: true, color: true },
        });
        // No row means deleted or soft-deleted (`prisma` filters those out),
        // i.e. someone who could no longer sign in. Returning null clears the
        // session cookie rather than re-signing a token for them.
        if (!fresh) {
          return null;
        }
        token.name = fresh.name;
        token.email = fresh.email;
        token.role = fresh.role;
        token.color = fresh.color;
      }

      return token;
    },
    session: async ({ session, token }) => {
      session.user.id = token.id;
      session.user.role = token.role;
      session.user.color = token.color;
      return session;
    },
  },
});
