// Runs after the whole suite (wired as the `setup` project's `teardown`).
// Individual fixtures already clean up after themselves; this is the net that
// catches whatever a crashed worker or a Ctrl+C left behind.
import { test as teardown } from "@playwright/test";
import { sweepTestData, disconnect } from "./db";

teardown("remove throwaway users, posts, docs, files and commenters", async () => {
  const { posts, docs, files, users, ydocs } = await sweepTestData();
  console.log(
    `e2e cleanup: removed ${posts} post(s), ${docs} doc(s), ${files} file(s), ${users} user(s), ${ydocs} ydoc(s).`,
  );
  disconnect();
});
