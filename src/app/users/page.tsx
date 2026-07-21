import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prismaIncludingDeleted } from "@/lib/prisma";
import { isAdmin } from "@/lib/authz";
import UsersTable from "@/components/UsersTable";

export default async function UsersPage() {
  const session = await auth();
  if (!session?.user) {
    redirect("/sign-in");
  }
  if (!isAdmin(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Users</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage users.</p>
      </main>
    );
  }

  const users = await prismaIncludingDeleted.user.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { postAuthors: true } } },
  });

  const rows = users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    adminInitials: user.adminInitials,
    role: user.role,
    moderationPolicy: user.moderationPolicy,
    color: user.color,
    image: user.image,
    createdAt: user.createdAt,
    postCount: user._count.postAuthors,
    deleted: user.deletedByUserId !== null,
  }));

  return (
    <main style={{ maxWidth: 1200, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Users</h1>
      <UsersTable rows={rows} />
    </main>
  );
}
