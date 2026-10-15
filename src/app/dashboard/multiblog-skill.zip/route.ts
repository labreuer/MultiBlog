import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { SKILL_NAME, skillZip } from "@/lib/mcp/skill";
import { signInPath } from "@/lib/sign-in-redirect";

// The MultiBlog skill for claude.ai, as the ZIP a person uploads under
// Customize > Skills (docs/MCP.md §21, "The skill"): the Connections card on
// /dashboard links here. Built per request from src/lib/mcp/skill.ts, so it
// always matches the tools this build serves, as `scripts/mcp-skill.ts`'s ZIP
// matches its checkout's. It names no account; signing in is asked for only
// because the card it comes from is behind it.
export async function GET() {
  const session = await auth();
  if (!session?.user) redirect(signInPath("/dashboard"));
  return new Response(skillZip(), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${SKILL_NAME}-skill.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
