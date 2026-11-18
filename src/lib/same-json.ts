/**
 * Whether two plain-JSON values are equal throughout: the same primitives,
 * arrays of the same length and order, objects with the same keys.
 *
 * For values that crossed a `postMessage` or a `fetch`, where nothing keeps
 * its identity and a `memo` comparing by reference never matches. Written
 * over keys and not over a type's named fields, so a field added to the type
 * later can't be left out of the comparison.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every(
    (key) => Object.hasOwn(b, key) && sameJson((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
