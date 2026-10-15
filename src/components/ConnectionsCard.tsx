import LocalTime from "@/components/LocalTime";
import RevokeTokenButton from "@/components/RevokeTokenButton";
import type { CardToken } from "@/lib/api/token-card";
import { projectInstructions } from "@/lib/mcp/skill";
import { mcpEndpointUrl } from "@/lib/oauth/discovery";
import styles from "./ConnectionsCard.module.css";

// The body of /dashboard's Connections card (docs/MCP.md §21, "Seeing and
// ending a connection"; docs/DASHBOARD.md "Connections"): the tokens the
// viewer issued or acts as, with Revoke for a live one, and what claude.ai
// needs besides a connection — the skill and the paragraph for a Project's
// instructions. A plain <table>, as Recent docs is: a fixed query with no
// filters, sort or paging, which is not the admin-table kit's contract.
//
// **The endpoint is said once, not per row**, while `/api/mcp` is the only
// one: every row's would be the same. It becomes a column with the
// read-only endpoint, if that is built (§21, "The read-only endpoint").

function State({ token }: { token: CardToken }) {
  switch (token.state.kind) {
    case "live":
      return <RevokeTokenButton tokenId={token.id} name={token.name} />;
    case "lapsed":
      // Nothing it holds still works, so there is nothing to revoke.
      return (
        <span className={styles.muted}>
          Lapsed{token.state.at && (
            <>
              {" "}
              <LocalTime value={token.state.at} precision="date" />
            </>
          )}
        </span>
      );
    case "expired":
      return (
        <span className={styles.muted}>
          Expired <LocalTime value={token.state.at} precision="date" />
        </span>
      );
  }
}

export default function ConnectionsCard({ tokens }: { tokens: CardToken[] }) {
  return (
    <>
      <p>
        AI agents you&rsquo;ve connected and the account each one works as: yours or one of your bots. To connect
        claude.ai, add a custom connector there with the URL <code>{mcpEndpointUrl().href}</code>, and approve it on
        the page it opens here. Revoking stops at the next action an agent attempts.
      </p>
      {tokens.length === 0 ? (
        <p className={`${styles.muted} ${styles.empty}`}>Nothing is connected.</p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Client</th>
                <th>Account</th>
                <th>Scopes</th>
                <th>Created</th>
                <th>Last used</th>
                <th aria-label="State" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td>{token.name}</td>
                  <td>
                    {token.client}
                    {token.header && <span className={styles.muted}> &middot; header token</span>}
                  </td>
                  <td>{token.account ?? "you"}</td>
                  <td>{token.scopes.map((scope) => scope.toLowerCase()).join(", ")}</td>
                  <td>
                    <LocalTime value={token.createdAt} precision="date" />
                  </td>
                  <td>{token.lastUsedAt ? <LocalTime value={token.lastUsedAt} precision="date" /> : <span className={styles.muted}>never</span>}</td>
                  <td>
                    <State token={token} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h3 className={styles.heading}>For claude.ai</h3>
      <p>A connection gives Claude the tools. Either of these tells it, in every chat, that your research is here:</p>
      <ul className={styles.list}>
        <li>
          <a href="/dashboard/multiblog-skill.zip" download>
            The MultiBlog skill
          </a>
          , to upload in claude.ai under Customize &rsaquo; Skills and turn on. A skill needs &ldquo;Code execution and
          file creation&rdquo; on.
        </li>
        <li>
          Without code execution, this paragraph in a Project&rsquo;s instructions does the same in that
          Project&rsquo;s chats:
          <p className={styles.paragraph}>{projectInstructions()}</p>
        </li>
      </ul>
    </>
  );
}
