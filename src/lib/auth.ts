import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { isSessionRecheckDue, sessionRecheckSeconds } from "@/lib/session-recheck";
import type { JWT } from "next-auth/jwt";
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

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          color: user.color,
          adminInitials: user.adminInitials,
        };
      },
    }),
  ],
  callbacks: {
    jwt: async ({ token, user, trigger }) => {
      const now = Math.floor(Date.now() / 1000);
      if (user) {
        token.id = user.id as string;
        token.role = (user as { role: Role }).role;
        token.color = (user as { color: string }).color;
        token.adminInitials = (user as { adminInitials: string }).adminInitials;
        token.checkedAt = now;
        return token;
      }

      // src/app/sign-in/NOTES.md, "The session reads its account again every
      // five minutes". Auth.js calls this on every read of the session, a
      // server component's `auth()` and a server action's included, so each
      // gate sees what the account is now within the interval of a change. A
      // POST to /api/auth/session (<SessionRefresh /> on /dashboard) asks for
      // the same read at once.
      const interval = sessionRecheckSeconds(process.env.SESSION_RECHECK_SECONDS);
      if (trigger === "update" || isSessionRecheckDue(token.checkedAt, now, interval)) {
        return tokenFromAccount(token, now);
      }
      return token;
    },
    session: async ({ session, token }) => {
      session.user.id = token.id;
      session.user.role = token.role;
      session.user.color = token.color;
      session.user.adminInitials = token.adminInitials;
      return session;
    },
  },
});

/**
 * The token with what its account holds now, and the time it was read, or
 * null when the account can no longer sign in: no row means deleted or
 * soft-deleted (`prisma` filters those out). A null from the `jwt` callback
 * ends the session, and the session route clears the cookie rather than
 * re-signing a token.
 *
 * A read that fails leaves the token as it was, still due, so the next call
 * reads again. Thrown from the callback, the failure would end the session
 * of everyone whose token came due while the database was away: Auth.js
 * answers an error there by clearing the cookie.
 */
async function tokenFromAccount(token: JWT, now: number): Promise<JWT | null> {
  if (!token.id) return null;
  let account;
  try {
    account = await prisma.user.findUnique({
      where: { id: token.id },
      select: { name: true, email: true, role: true, color: true, adminInitials: true },
    });
  } catch (err) {
    console.error("[auth] the session's account couldn't be read; keeping the token until the next read", err);
    return token;
  }
  if (!account) return null;
  token.name = account.name;
  token.email = account.email;
  token.role = account.role;
  token.color = account.color;
  token.adminInitials = account.adminInitials;
  token.checkedAt = now;
  return token;
}
