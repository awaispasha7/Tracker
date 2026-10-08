import type { Database } from '../db/database.ts';

export interface OutboundMessage {
  dedupeKey: string;
  recipient: string;
  subject: string;
  body: string;
  channel?: 'email' | 'sms';
}

export interface Sender {
  send(msg: { channel: string; recipient: string; subject: string; body: string }): Promise<void>;
}

/** Logs instead of sending. Swap for SES/Postmark/Twilio in production. */
export const consoleSender: Sender = {
  async send(msg) {
    console.log(`[notify:${msg.channel}] to=${msg.recipient} subject="${msg.subject}"`);
  },
};

/**
 * Transactional outbox. Messages are written in the same transaction as the state change that
 * caused them (so a rollback never leaves a stray "your flight is confirmed" email), deduplicated
 * by key (so re-processing an event never double-notifies), and delivered asynchronously.
 */
export class Outbox {
  private db: Database;
  constructor(db: Database) {
    this.db = db;
  }

  enqueue(msg: OutboundMessage, now: number): boolean {
    return this.db.run(
      `INSERT OR IGNORE INTO notifications (dedupe_key, channel, recipient, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      msg.dedupeKey, msg.channel ?? 'email', msg.recipient, msg.subject, msg.body, now,
    ).changes === 1;
  }

  async drain(sender: Sender, now: number, limit = 100): Promise<number> {
    const rows = this.db.all<{ id: number; channel: string; recipient: string; subject: string; body: string }>(
      'SELECT id, channel, recipient, subject, body FROM notifications WHERE sent_at IS NULL ORDER BY id LIMIT ?', limit,
    );
    let sent = 0;
    for (const r of rows) {
      try {
        await sender.send(r);
        this.db.run('UPDATE notifications SET sent_at = ? WHERE id = ?', now, r.id);
        sent++;
      } catch (e) {
        console.error(`[notify] delivery failed for #${r.id}:`, e);
      }
    }
    return sent;
  }

  list(recipient?: string, limit = 50) {
    return recipient
      ? this.db.all('SELECT * FROM notifications WHERE recipient = ? ORDER BY id DESC LIMIT ?', recipient, limit)
      : this.db.all('SELECT * FROM notifications ORDER BY id DESC LIMIT ?', limit);
  }
}
