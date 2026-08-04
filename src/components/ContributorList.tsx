import { getContributors } from "@/lib/contributors";
import ContributorCard from "./ContributorCard";
import styles from "./ContributorList.module.css";

// The landing page's right-hand (PLAN.md §17e/§17l) contributor list — a
// server component with no auth() call, same constraint as the rest of `/`
// (§17a): it must stay renderable by a shared, ISR-cached page.
export default async function ContributorList() {
  const contributors = await getContributors();
  if (contributors.length === 0) {
    return null;
  }

  return (
    <aside className={styles.list}>
      <h2 className={styles.heading}>Contributors</h2>
      {contributors.map((c) => (
        <ContributorCard
          key={c.id}
          name={c.name}
          slug={c.slug}
          avatarSrc={c.avatarSrc}
          color={c.color}
          adminInitials={c.adminInitials}
          orcid={c.orcid}
          website={c.website}
          blurb={c.contributorBlurb}
        />
      ))}
    </aside>
  );
}
