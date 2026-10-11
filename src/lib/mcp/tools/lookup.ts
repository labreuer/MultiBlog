import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { BYLINE_ELIGIBLE_ROLES } from "@/lib/role-checks";
import { invalid } from "@/lib/api/errors";
import { defineTool } from "../tool";

// docs/MCP.md §11 and §12 — the two lookups a write needs and `search`
// doesn't answer: who may go on a byline, and which tag terms exist.

const MAX_RESULTS = 20;

export const findUsersTool = defineTool({
  name: "find_users",
  scope: "READ",
  description:
    "Byline-eligible accounts (ADMIN, EDITOR, AUTHOR) by name or author slug, or one account by its exact email. Answers id, slug and name: enough to name someone on a byline. An account without a name is found only by its exact email, since its slug is made from that email.",
  input: z.strictObject({
    query: z.string().min(1).max(100).optional().describe("Part of a name or slug."),
    email: z.string().email().max(320).optional().describe("An exact email address."),
  }),
  output: z.object({ users: z.array(z.object({ id: z.string(), slug: z.string().optional(), name: z.string().nullable() })) }),
  readOnly: true,
  destructive: false,
  searchHint: "people user author byline lookup email slug",
  async run(args) {
    if ((args.query === undefined) === (args.email === undefined)) {
      throw invalid("Give query or email, one of them.");
    }
    if (args.email !== undefined) {
      // The filtered client, so a deleted account isn't found.
      const user = await prisma.user.findFirst({
        where: { email: { equals: args.email.trim(), mode: "insensitive" } },
        select: { id: true, slug: true, name: true, role: true },
      });
      return {
        users: user && BYLINE_ELIGIBLE_ROLES.includes(user.role) ? [{ id: user.id, slug: user.slug, name: user.name }] : [],
      };
    }
    const q = args.query!.trim();
    const users = await prisma.user.findMany({
      where: {
        role: { in: BYLINE_ELIGIBLE_ROLES },
        name: { not: null },
        OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q.toLowerCase() } }],
      },
      select: { id: true, slug: true, name: true },
      orderBy: { name: "asc" },
      take: MAX_RESULTS,
    });
    return { users: users.filter((u) => u.name?.trim()).map((u) => ({ id: u.id, slug: u.slug, name: u.name })) };
  },
});

export const findTagsTool = defineTool({
  name: "find_tags",
  scope: "READ",
  description:
    "Tag terms by name: each one's name, slug and description. A term carries no visibility of its own, so every live term is listed; what carries it is `search` with tags:[slug], or read of /tag/<slug>.",
  input: z.strictObject({ query: z.string().min(1).max(100).describe("Part of a term's name.") }),
  output: z.object({
    tags: z.array(z.object({ name: z.string(), slug: z.string(), description: z.string().optional() })),
  }),
  readOnly: true,
  destructive: false,
  searchHint: "tag term vocabulary label topic",
  async run(args) {
    const tags = await prisma.tag.findMany({
      where: { name: { contains: args.query.trim(), mode: "insensitive" } },
      select: { name: true, slug: true, description: true },
      orderBy: { name: "asc" },
      take: MAX_RESULTS,
    });
    return {
      tags: tags.map((tag) => ({ name: tag.name, slug: tag.slug, ...(tag.description ? { description: tag.description } : {}) })),
    };
  },
});
