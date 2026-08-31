import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/lib/auth";
import { isAdmin } from "@/lib/authz";
import { getSiteSettings } from "@/lib/site-settings";
import { SITE_TITLE } from "@/lib/site-config";
import { columnOrderFor, type AdminTableName } from "@/lib/column-order";
import { ADMIN_TABLE_COLUMNS, codeDefaultColumns } from "@/lib/admin-table-columns";
import { signInPath } from "@/lib/sign-in-redirect";
import SiteSettingsTable, { type ConfigRow, type DefaultColumnsRow } from "@/components/SiteSettingsTable";

export const metadata: Metadata = { title: "Site settings" };

const TABLE_LABELS: Record<AdminTableName, string> = {
  posts: "/posts",
  docs: "/docs",
  files: "/files",
  users: "/users",
  comments: "/comments",
  annotations: "/annotations",
  tags: "/tags",
};

// One entry per exported constant in site-config.ts (see PLAN.md §6 for how
// this page fits the moderation settings). Update this list alongside that
// file. All entries currently live in the same file and need the same steps
// to take effect, hence the single CONFIG_LOCATION/CONFIG_TO_CHANGE below
// rather than per-row fields.
const CONFIG_LOCATION = "src/lib/site-config.ts";
const CONFIG_TO_CHANGE =
  "Edit the constant (or, for SITE_TITLE, set NEXT_PUBLIC_SITE_TITLE in .env instead so it " +
  "survives a git pull), then deploy — or restart the dev server locally; HMR often picks it " +
  "up without one.";
const CONFIG_ROWS: ConfigRow[] = [{ name: "SITE_TITLE", value: SITE_TITLE }];

export default async function SiteSettingsPage() {
  const session = await auth();
  if (!session?.user) {
    redirect(signInPath("/site-settings"));
  }
  if (!isAdmin(session.user.role)) {
    return (
      <main style={{ maxWidth: 640, margin: "4rem auto", fontFamily: "sans-serif" }}>
        <h1>Site settings</h1>
        <p>Your account ({session.user.role}) doesn&apos;t have permission to manage site settings.</p>
      </main>
    );
  }

  const siteSettings = await getSiteSettings();

  // One read of the whole SiteSettings row (already fetched above) decoded
  // five ways, rather than five separate `getSiteDefaultColumnOrder` calls —
  // each of those re-upserts/re-reads the same singleton row.
  const defaultColumns: DefaultColumnsRow[] = (Object.keys(ADMIN_TABLE_COLUMNS) as AdminTableName[]).map((table) => ({
    table,
    label: TABLE_LABELS[table],
    columns: ADMIN_TABLE_COLUMNS[table],
    initialChecked: columnOrderFor(siteSettings.defaultColumnOrder, table) ?? codeDefaultColumns(table),
  }));

  return (
    <main style={{ maxWidth: 1000, margin: "4rem auto", fontFamily: "sans-serif" }}>
      <h1>Site settings</h1>
      <SiteSettingsTable
        siteSettings={{
          defaultModerationPolicy: siteSettings.defaultModerationPolicy === "AUTO" ? "AUTO" : "ALWAYS",
          trustThreshold: siteSettings.trustThreshold,
        }}
        configRows={CONFIG_ROWS}
        configLocation={CONFIG_LOCATION}
        configToChange={CONFIG_TO_CHANGE}
        defaultColumns={defaultColumns}
      />
    </main>
  );
}
