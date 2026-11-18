-- docs/EMAIL.md §10, "Minting and printing" — /join-codes' status column, as
-- a view keyed 1:1 on join_code.id so the table can sort and filter by it
-- through Prisma (CLAUDE.md, "Admin tables are one kit").
--
-- The order of the CASE is `stateOf`'s in src/lib/join-codes/cards.ts, which
-- answers /join/<code>: a claimed card is claimed whatever its batch did
-- since; a revoked card or batch, then an expired batch, can no longer be
-- used; then a card whose five sends are used up (MAX_CONFIRM_SENDS there).
-- A live card is split by whether a claim waits on it.
--
-- `expires_at` is a timestamp without a time zone, holding UTC, so the clock
-- it is compared with is `now() AT TIME ZONE 'UTC'`: a bare now() would be
-- read in the session's zone and move expiry by its offset.
CREATE VIEW "join_code_listing" AS
SELECT
  s.join_code_id,
  s.status,
  CASE s.status
    WHEN 'unclaimed' THEN 1
    WHEN 'pending' THEN 2
    WHEN 'sends-used' THEN 3
    WHEN 'claimed' THEN 4
    WHEN 'expired' THEN 5
    ELSE 6
  END AS status_order
FROM (
  SELECT
    jc.id AS join_code_id,
    CASE
      WHEN jc.claimed_at IS NOT NULL THEN 'claimed'
      WHEN jc.revoked_at IS NOT NULL OR jb.revoked_at IS NOT NULL THEN 'revoked'
      WHEN jb.expires_at <= (now() AT TIME ZONE 'UTC') THEN 'expired'
      WHEN jc.confirm_sends >= 5 THEN 'sends-used'
      WHEN jc.pending_email IS NOT NULL THEN 'pending'
      ELSE 'unclaimed'
    END AS status
  FROM "join_code" jc
  JOIN "join_batch" jb ON jb.id = jc.batch_id
) s;
