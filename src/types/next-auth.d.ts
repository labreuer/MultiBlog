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
    // Optional: a token issued before this field existed lacks it until the
    // jwt callback backfills it (src/lib/auth.ts).
    adminInitials?: string;
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    id: string;
    role: Role;
    color: string;
    // Optional: a token issued before this field existed lacks it until the
    // jwt callback backfills it (src/lib/auth.ts).
    adminInitials?: string;
  }
}
