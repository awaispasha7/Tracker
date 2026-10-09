// Real email delivery through Resend (https://resend.com, free tier: 3,000 emails/month).
//
// Recipients in the outbox are either email addresses or `operator:<id>`, which resolves to the
// operator's contact email. Messages to operators and booking events are also copied to the ops
// inbox, so a human sees every request even if an operator ignores their email.

import type { FleetRepo } from '../db/repos.ts';
import type { Sender } from './outbox.ts';

export interface EmailConfig {
  apiKey: string;
  /** e.g. "Aurum Jets <bookings@aurumjets.com>" — the domain must be verified in Resend. */
  from: string;
  /** Ops inbox that is copied on operator messages; optional. */
  opsEmail?: string;
  replyTo?: string;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; text(): Promise<string> }>;

export function resendSender(config: EmailConfig, fleet: FleetRepo, fetchImpl: Fetch = globalThis.fetch as unknown as Fetch): Sender {
  return {
    async send(msg) {
      if (msg.channel !== 'email') return;
      let to = msg.recipient;
      if (to.startsWith('operator:')) {
        const op = fleet.getOperator(to.slice('operator:'.length));
        to = op?.contact?.email ?? '';
        if (!to && !config.opsEmail) return;
      }
      const recipients = [to, msg.recipient.startsWith('operator:') ? config.opsEmail : undefined].filter((x): x is string => !!x && x.includes('@'));
      if (!recipients.length) return;
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: config.from, to: recipients, subject: msg.subject, text: msg.body, reply_to: config.replyTo }),
      });
      // 4xx other than rate limiting won't succeed on retry; log and drop so the outbox doesn't loop.
      if (res.status === 429 || res.status >= 500) throw new Error(`Resend ${res.status}: ${await res.text()}`);
      if (res.status >= 400) console.error(`[email] Resend rejected "${msg.subject}" to ${recipients.join(', ')}: ${res.status} ${await res.text()}`);
    },
  };
}
