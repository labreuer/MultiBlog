type SendMailInput = {
  to: string;
  subject: string;
  text: string;
};

// Dev stub: logs instead of sending. Swap for SMTP/Resend/etc. behind this
// same signature when a real provider is wired up.
export async function sendMail({ to, subject, text }: SendMailInput): Promise<void> {
  console.log(`[mail] to=${to} subject="${subject}"\n${text}`);
}
