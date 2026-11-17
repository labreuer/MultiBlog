// Which columns a unique violation was on, as Prisma reports it. Pure, so
// unique-violation.test.ts can hold the error shapes without a database.
//
// Prisma 7.9 builds a driver adapter's P2002 with no `meta.target`: the
// columns are in `meta.driverAdapterError.cause.constraint.fields`, which
// `@prisma/adapter-pg` parses from Postgres's detail line
// (`Key (slug)=(…) already exists`) and leaves out when that parse misses. So
// each step of the path is checked rather than assumed, and `meta.target` is
// still read, for a client that sets it.

type Meta = {
  target?: unknown;
  driverAdapterError?: { cause?: { constraint?: { fields?: unknown } } };
};

/** Whether `err` is a P2002 that names `column` among the columns it was on. */
export function isUniqueViolationOn(err: unknown, column: string): boolean {
  if ((err as { code?: unknown } | null)?.code !== "P2002") return false;
  const meta = (err as { meta?: Meta }).meta;
  const names = (value: unknown) => (Array.isArray(value) ? value.includes(column) : value === column);
  return names(meta?.target) || names(meta?.driverAdapterError?.cause?.constraint?.fields);
}
