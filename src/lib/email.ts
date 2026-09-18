import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Email delivery.
 *
 * `nodemailer` was already a dependency but nothing imported it, so the email
 * notification channel in the UI toggled a setting that did nothing. Falls back
 * to logging in development when SMTP is not configured.
 */

let cachedTransport: Transporter | null | undefined;

function getTransport(): Transporter | null {
  if (cachedTransport !== undefined) return cachedTransport;

  const host = process.env.EMAIL_HOST;
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!host || !user || !pass) {
    cachedTransport = null;
    return null;
  }

  const port = Number(process.env.EMAIL_PORT ?? 587);

  cachedTransport = nodemailer.createTransport({
    host,
    port,
    // 465 is implicit TLS; 587 upgrades via STARTTLS.
    secure: port === 465,
    auth: { user, pass },
  });

  return cachedTransport;
}

export function isEmailConfigured(): boolean {
  return getTransport() !== null;
}

export interface MailInput {
  to: string;
  subject: string;
  /** Plain-text body. Always provided so the message degrades gracefully. */
  text: string;
  /** Optional HTML body. */
  html?: string;
}

export async function sendEmail(input: MailInput): Promise<{ success: boolean; error?: string }> {
  const transport = getTransport();

  if (!transport) {
    console.log(`[DEV MOCK] Email to ${input.to}: ${input.subject}\n${input.text}`);
    return { success: true };
  }

  try {
    await transport.sendMail({
      from: process.env.EMAIL_FROM || `VTULA <${process.env.EMAIL_USER}>`,
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return { success: true };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('sendEmail error:', msg);
    return { success: false, error: msg };
  }
}

/** Wraps a message body in the standard VTULA email shell. */
export function renderEmailHtml(opts: {
  heading: string;
  body: string;
  actionUrl?: string;
  actionLabel?: string;
}): string {
  const button =
    opts.actionUrl && opts.actionLabel
      ? `<p style="margin:24px 0"><a href="${opts.actionUrl}" style="background:#E07A5F;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block">${opts.actionLabel}</a></p>`
      : '';

  return `<!doctype html>
<html lang="en"><body style="margin:0;padding:24px;background:#F4F1EC;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#3D405B">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
    <table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:16px;padding:32px">
      <tr><td>
        <div style="font-weight:800;font-size:1.1rem;letter-spacing:.5px;color:#E07A5F">VTULA</div>
        <div style="font-size:.8rem;color:#6b6f8d;margin-bottom:20px">Legal Metrology verification &amp; trust platform</div>
        <h1 style="font-size:1.25rem;margin:0 0 12px">${opts.heading}</h1>
        <div style="font-size:.95rem;line-height:1.6">${opts.body}</div>
        ${button}
        <hr style="border:none;border-top:1px solid #e8e4dd;margin:24px 0">
        <p style="font-size:.75rem;color:#8b8fa8;margin:0">
          This is an automated message about your instrument verification records.
          VTULA is a compliance workflow platform and does not itself constitute a statutory authority.
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}
