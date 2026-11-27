import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';

/**
 * Sends email over SMTP (any provider: Gmail app password, Brevo, Resend SMTP,
 * Amazon SES, …). Configure in .env:
 *   SMTP_HOST, SMTP_PORT (587 or 465), SMTP_USER, SMTP_PASS, MAIL_FROM
 * Without SMTP settings, emails are only written to the server log.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly transport: Transporter | null;
  private readonly from: string;
  private readonly brevoKey: string | undefined;

  constructor(config: ConfigService) {
    this.brevoKey = config.get<string>('BREVO_API_KEY') || undefined;
    const host = config.get<string>('SMTP_HOST');
    const user = config.get<string>('SMTP_USER');
    const pass = config.get<string>('SMTP_PASS');
    const port = Number(config.get('SMTP_PORT', 587));
    this.from = config.get<string>('MAIL_FROM') || (user ? `FitFlow <${user}>` : 'FitFlow <no-reply@fitflow.local>');
    this.transport =
      host && user && pass
        ? nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } })
        : null;
    if (!this.transport) this.logger.warn('SMTP is not configured — emails will only be logged (set SMTP_HOST/SMTP_USER/SMTP_PASS).');
  }

  get configured() {
    return !!this.transport || !!this.brevoKey;
  }

  /**
   * Sends a template saved in Brevo (Transactional → Templates), passing only the
   * values; the template uses them as {{ params.name }}, {{ params.code }}, …
   * Needs BREVO_API_KEY and a template id. If either is missing or Brevo refuses,
   * the fallback email goes out over SMTP instead. Never throws.
   */
  async sendTemplate(
    to: string,
    templateId: number | undefined,
    params: Record<string, string | number>,
    fallback: { subject: string; html: string; text: string },
  ): Promise<boolean> {
    if (this.brevoKey && templateId) {
      try {
        const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(this.from);
        const sender = m ? { name: m[1] || 'FitFlow', email: m[2] } : { email: this.from };
        const res = await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': this.brevoKey, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ sender, to: [{ email: to }], templateId, params }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          this.logger.log(`Email sent to ${to} with Brevo template #${templateId}`);
          return true;
        }
        this.logger.error(`Brevo template #${templateId} to ${to} failed (${res.status}): ${await res.text()} — using SMTP instead`);
      } catch (e) {
        this.logger.error(`Brevo template #${templateId} to ${to} failed: ${(e as Error).message} — using SMTP instead`);
      }
    }
    return this.send(to, fallback.subject, fallback.html, fallback.text);
  }

  /** Never throws: a mail failure must not break sign-up or password reset. */
  async send(to: string, subject: string, html: string, text: string): Promise<boolean> {
    if (!this.transport) {
      this.logger.log(`[email → ${to}] ${subject} — ${text}`);
      return false;
    }
    try {
      await this.transport.sendMail({ from: this.from, to, subject, html, text });
      this.logger.log(`Email sent to ${to}: ${subject}`);
      return true;
    } catch (e) {
      this.logger.error(`Email to ${to} failed: ${(e as Error).message}`);
      return false;
    }
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}

// ----------------------------------------------------------------------------
// Templates

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Branded code email (FitFlow navy + lime), works in all major mail apps. */
export function codeEmail(opts: { name: string; heading: string; intro: string; code: string; minutes: number; footer: string }) {
  const digits = opts.code.split('').join('&nbsp;');
  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#0B1520;font-family:Poppins,Segoe UI,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#0B1520;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#132233;border:1px solid #22344A;border-radius:24px;">
<tr><td style="padding:32px 28px 8px;text-align:center;">
<div style="font-size:24px;font-weight:700;color:#FFFFFF;">&#9889; Fit<span style="color:#C8F135;">Flow</span></div>
</td></tr>
<tr><td style="padding:8px 28px 0;text-align:center;">
<h1 style="margin:16px 0 8px;font-size:22px;color:#FFFFFF;">${esc(opts.heading)}</h1>
<p style="margin:0;font-size:15px;line-height:1.6;color:#A9B6C6;">Hi ${esc(opts.name)}, ${esc(opts.intro)}</p>
</td></tr>
<tr><td align="center" style="padding:24px 28px;">
<div style="display:inline-block;padding:16px 24px;border-radius:16px;background:#0B1520;border:1px solid #C8F135;font-size:32px;font-weight:700;letter-spacing:6px;color:#C8F135;">${digits}</div>
<p style="margin:14px 0 0;font-size:13px;color:#7D8DA1;">This code expires in ${opts.minutes} minutes.</p>
</td></tr>
<tr><td style="padding:0 28px 28px;text-align:center;">
<p style="margin:0;font-size:12px;line-height:1.6;color:#7D8DA1;">${esc(opts.footer)}</p>
</td></tr>
</table>
<p style="margin:16px 0 0;font-size:11px;color:#4F6074;">FitFlow · Train smarter. Live stronger.</p>
</td></tr></table>
</body></html>`;
  const text = `Hi ${opts.name}, ${opts.intro}\n\nYour code: ${opts.code}\nIt expires in ${opts.minutes} minutes.\n\n${opts.footer}`;
  return { html, text };
}
