// The one place `process.env.APP_URL` is read. Was duplicated at
// forgot-password.ts and annotations.ts (each with its own
// `?? "http://localhost:3000"` fallback) before docs/EMAIL.md's invite links
// became a third call site — worth centralizing once it's not just two.
export function appUrl(path: string): string {
  const base = process.env.APP_URL ?? "http://localhost:3000";
  return `${base}${path}`;
}
