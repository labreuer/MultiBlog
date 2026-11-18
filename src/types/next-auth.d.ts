import type { DefaultSession } from "next-auth";
import type { Role } from "@/generated/prisma/enums";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: Role;
      color: string;
      adminInitials: string;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: Role;
    color: string;
    adminInitials: string;
    /**
     * When the account was last read, in epoch seconds: at sign-in and at
     * every re-read (src/lib/auth.ts). Optional, since a token issued before
     * the field existed has none, which makes it due at once.
     */
    checkedAt?: number;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id: string;
    role: Role;
    color: string;
    adminInitials: string;
    /**
     * When the account was last read, in epoch seconds: at sign-in and at
     * every re-read (src/lib/auth.ts). Optional, since a token issued before
     * the field existed has none, which makes it due at once.
     */
    checkedAt?: number;
  }
}
