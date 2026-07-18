type CheckSpamInput = {
  body: string;
  displayName: string;
  email: string;
  ipAddress: string | null;
};

// Dev stub: no AKISMET_API_KEY is configured, so this always says "not
// spam" and logs instead of calling out. Swap for a real Akismet
// comment-check request (https://akismet.com/developers/comment-check/)
// behind this same signature when a key is available — same seam as
// sendMail() in mail.ts.
export async function checkSpam({ body, displayName, email, ipAddress }: CheckSpamInput): Promise<boolean> {
  if (!process.env.AKISMET_API_KEY) {
    console.log(`[spam-check] stub: skipping check for comment from ${displayName} <${email}> (${ipAddress ?? "no IP"})`);
    return false;
  }
  console.log(`[spam-check] AKISMET_API_KEY is set but no client is wired up yet; treating "${body.slice(0, 40)}" as not spam.`);
  return false;
}
