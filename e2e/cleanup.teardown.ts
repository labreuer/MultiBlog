// Runs after the whole suite (wired as the `setup` project's `teardown`).
// Individual fixtures already clean up after themselves; this is the net that
// catches whatever a crashed worker or a Ctrl+C left behind.
import { test as teardown } from "@playwright/test";
import { sweepTestData, disconnect } from "./db";

teardown("remove throwaway users, posts, docs, files, keywords and commenters", async () => {
  const { posts, docs, files, keywords, users, ydocs } = await sweepTestData();
  console.log(
    `e2e cleanup: removed ${posts} post(s), ${docs} doc(s), ${files} file(s), ` +
      `${keywords} keyword(s), ${users} user(s), ${ydocs} ydoc(s).`,
  );
  disconnect();
});
