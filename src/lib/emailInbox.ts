/**
 * Email inbox I/O for the "Remi operates the clinic's own mailbox" channel.
 *
 * IMAP (imapflow) to read unseen messages, SMTP (nodemailer) to reply in-thread
 * from the clinic's real address. Pure orchestration (triage + brain) lives in
 * the scheduler; this file is just the transport, so it stays mockable/testable.
 */
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

export interface EmailInboxConfig {
  imap_host: string;
  imap_port?: number; // default 993 (implicit TLS)
  smtp_host: string;
  smtp_port?: number; // default 465 (implicit TLS); 587 = STARTTLS
  user: string; // mailbox login — usually the clinic's email address
  pass: string; // app-password (secret)
  from_name?: string; // display name on replies (e.g. the clinic name)
  enabled?: boolean;
}

export interface InboundEmail {
  uid: number;
  fromAddress: string;
  fromName: string;
  subject: string;
  text: string;
  messageId: string;
  references: string[];
  date: Date | null;
  autoSubmitted: boolean; // header hint that this is an automated/bulk message
}

function imapClient(cfg: EmailInboxConfig): ImapFlow {
  const port = cfg.imap_port ?? 993;
  return new ImapFlow({
    host: cfg.imap_host,
    port,
    secure: port === 993,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });
}

/**
 * Connect, read up to `limit` UNSEEN messages from INBOX, hand each to `handle`,
 * then mark it \Seen so it isn't processed again. One connection for the whole
 * batch. `handle` does triage + brain + reply; its result is only used for logs.
 * A throw inside `handle` is swallowed (logged) so one bad email can't strand the
 * rest of the batch — but the message is still marked seen to avoid a poison loop.
 */
export async function processInbox(
  cfg: EmailInboxConfig,
  handle: (email: InboundEmail) => Promise<'replied' | 'skipped'>,
  limit = 10,
): Promise<{ fetched: number; replied: number; skipped: number; errors: number }> {
  const client = imapClient(cfg);
  let replied = 0,
    skipped = 0,
    errors = 0,
    fetched = 0;
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const uids = (await client.search({ seen: false }, { uid: true })) || [];
    for (const uid of uids.slice(0, limit)) {
      fetched++;
      try {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          continue;
        }
        const email = await parseSource(uid, msg.source);
        const result = await handle(email);
        result === 'replied' ? replied++ : skipped++;
      } catch (e) {
        errors++;
        console.error('[emailInbox] error handling uid', uid, (e as Error)?.message ?? e);
      } finally {
        // Always mark seen — a message we failed on shouldn't be retried forever.
        try {
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
  return { fetched, replied, skipped, errors };
}

async function parseSource(uid: number, source: Buffer): Promise<InboundEmail> {
  const p = await simpleParser(source);
  const fromVal = p.from?.value?.[0];
  const refs = p.references;
  const autoSubmitted =
    String((p.headers.get('auto-submitted') as string) ?? '').toLowerCase() !== '' &&
      String((p.headers.get('auto-submitted') as string) ?? '').toLowerCase() !== 'no'
      ? true
      : String((p.headers.get('precedence') as string) ?? '').toLowerCase() === 'bulk' ||
        p.headers.has('list-unsubscribe');
  return {
    uid,
    fromAddress: (fromVal?.address ?? '').toLowerCase(),
    fromName: fromVal?.name ?? '',
    subject: p.subject ?? '',
    text: (p.text ?? '').trim(),
    messageId: p.messageId ?? '',
    references: Array.isArray(refs) ? refs : refs ? [refs] : [],
    date: p.date ?? null,
    autoSubmitted,
  };
}

/** Send a threaded reply from the clinic's mailbox via SMTP. */
export async function sendEmailReply(
  cfg: EmailInboxConfig,
  opts: { to: string; subject: string; text: string; inReplyTo?: string; references?: string[] },
): Promise<void> {
  const port = cfg.smtp_port ?? 465;
  const transport = nodemailer.createTransport({
    host: cfg.smtp_host,
    port,
    secure: port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  });
  await transport.sendMail({
    from: cfg.from_name ? `"${cfg.from_name}" <${cfg.user}>` : cfg.user,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
    ...(opts.references && opts.references.length ? { references: opts.references } : {}),
  });
}

/** "Re: ..." subject without doubling the prefix. Pure — testable. */
export function replySubject(original: string): string {
  const s = (original ?? '').trim();
  return /^re:/i.test(s) ? s : `Re: ${s || 'your enquiry'}`;
}
