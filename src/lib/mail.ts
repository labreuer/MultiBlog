// Real delivery behind the same seam this used to log through. Full design
// (why Resend, what the reserved-domain refusal buys, why this never throws):
// docs/EMAIL.md.

// `template` is mutually exclusive with subject/text/html at Resend's own API
// level ("Cannot combine template with html, text, or react") — modeled as a
// union rather than all-optional fields so that constraint is a type error,
// not a runtime surprise. `sendUserInvite` (docs/EMAIL.md §4) is the one
// caller using the template branch today.
type MailContent =
  | {
      subject: string;
      text: string;
      /** Optional HTML alternative; `text` is always sent as well. */
      html?: string;
      template?: undefined;
    }
  | {
      /** A Resend Template id (or alias) plus the variables it declares. */
      template: { id: string; variables: Record<string, string> };
      subject?: undefined;
      text?: undefined;
      html?: undefined;
    };

export type SendMailInput = {
  to: string;
  /** Overrides MAIL_FROM. Nothing sets this today — reserved for a future
   * transactional/notification sender split, which the current callers
   * (auth, invites, RAISED annotations) don't need: their subject lines
   * already carry the distinction. */
  from?: string;
} & MailContent;

export type SendMailResult = { delivered: boolean; error?: string };

// Recipients on these domains are never delivered to, in every environment,
// key or no key. e2e/naming.ts's SAFE_EMAIL guarantees the suite only ever
// creates @example.com addresses, and scripts/seed-sample-data.ts uses
// @sample.invalid — so this is what makes "the suite cannot send mail"
// structural rather than a matter of .env discipline. Without it, the day a
// live key lands in a dev .env, `npm run e2e` becomes a burst of hard bounces
// against your own sending domain, which is the fastest way to get throttled.
const RESERVED_RECIPIENT_DOMAIN = /@(example\.com|sample\.invalid)$/i;

function describe(content: MailContent): { subject: string; body: string } {
  if (content.template) {
    const { id, variables } = content.template;
    return { subject: `(template ${id})`, body: JSON.stringify(variables) };
  }
  return { subject: content.subject, body: content.text };
}

function logMail(to: string, content: MailContent, note?: string): void {
  const { subject, body } = describe(content);
  console.log(`[mail] to=${to} subject="${subject}"${note ? ` ${note}` : ""}\n${body}`);
}

// Never throws. If it did, requestPasswordReset would throw for an address
// that exists and return its generic message for one that doesn't — a perfect
// enumeration oracle, defeating the exact property that file's own comment
// exists to protect. Failures are logged here and reported back as
// `{ delivered: false }` for a caller that can act on it; the log path always
// reports success, so every caller's success branch gets exercised locally
// and in e2e without a provider ever being configured.
export async function sendMail({ to, from, ...content }: SendMailInput): Promise<SendMailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const mailFrom = process.env.MAIL_FROM;

  if (RESERVED_RECIPIENT_DOMAIN.test(to)) {
    logMail(to, content, "(not delivered: reserved domain)");
    return { delivered: true };
  }

  if (!apiKey || !mailFrom) {
    logMail(to, content);
    return { delivered: true };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: from ?? mailFrom,
        to,
        ...(content.template
          ? { template: content.template }
          : { subject: content.subject, text: content.text, ...(content.html ? { html: content.html } : {}) }),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const error = `Resend responded ${res.status}${body ? `: ${body}` : ""}`;
      console.error(`[mail] delivery to ${to} failed: ${error}`);
      return { delivered: false, error };
    }

    return { delivered: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error(`[mail] delivery to ${to} failed: ${error}`);
    return { delivered: false, error };
  }
}
