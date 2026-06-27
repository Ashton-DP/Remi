// Email-inbox pure-logic tests. Run: tsx tests/emailInbox.test.ts
// Covers the safety rail (preFilter — decides what Remi must NOT reply to) and
// the reply-subject helper. The IMAP/SMTP I/O is not unit-tested (needs a live
// mailbox); the brain triage AI call is covered by manual/live testing.
import assert from 'node:assert';
import { preFilter } from '../src/lib/emailTriage';
import { replySubject } from '../src/lib/emailInbox';
import type { InboundEmail } from '../src/lib/emailInbox';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

function email(over: Partial<InboundEmail>): InboundEmail {
  return {
    uid: 1, fromAddress: 'sarah@gmail.com', fromName: 'Sarah', subject: 'Booking',
    text: 'Can I book a Botox consult next week?', messageId: '<a@b>', references: [],
    date: null, autoSubmitted: false, ...over,
  };
}

console.log('email inbox / triage');

const MAILBOX = 'bookings@clinic.co.za';

test('preFilter passes a genuine client email', () => {
  assert.equal(preFilter(email({}), MAILBOX), null);
});
test('preFilter blocks our own mailbox (loop guard)', () => {
  assert.ok(preFilter(email({ fromAddress: MAILBOX }), MAILBOX));
});
test('preFilter blocks no-reply / automated senders', () => {
  assert.ok(preFilter(email({ fromAddress: 'no-reply@news.com' }), MAILBOX));
  assert.ok(preFilter(email({ fromAddress: 'noreply@x.com' }), MAILBOX));
  assert.ok(preFilter(email({ fromAddress: 'mailer-daemon@x.com' }), MAILBOX));
  assert.ok(preFilter(email({ fromAddress: 'newsletter@brand.com' }), MAILBOX));
});
test('preFilter blocks auto-submitted / bulk mail', () => {
  assert.ok(preFilter(email({ autoSubmitted: true }), MAILBOX));
});
test('preFilter blocks empty body and invalid sender', () => {
  assert.ok(preFilter(email({ text: '' }), MAILBOX));
  assert.ok(preFilter(email({ fromAddress: 'not-an-email' }), MAILBOX));
});

test('replySubject adds Re: once and preserves an existing one', () => {
  assert.equal(replySubject('Booking question'), 'Re: Booking question');
  assert.equal(replySubject('Re: Booking question'), 'Re: Booking question');
  assert.equal(replySubject('RE: hi'), 'RE: hi');
  assert.equal(replySubject(''), 'Re: your enquiry');
});

console.log(`\n${passed} passed`);
