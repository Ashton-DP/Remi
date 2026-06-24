// Invoice-chasing pure-logic tests. Run: tsx tests/chase.test.ts
import assert from 'node:assert';
import {
  nextChaseStage, daysOverdue, phoneKey, emailKey, formatMoney, amountTier,
  buildChaseFallback, classifyInvoiceReply, parseInvoiceCsv, normaliseDate,
  DEFAULT_CADENCE,
} from '../src/lib/chase';
import { parseEmailMessage, buildChaseEmailHtml } from '../src/lib/email';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}

const NOW = new Date('2026-06-23T08:00:00Z');

console.log('invoice chasing — pure logic');

// ── nextChaseStage ───────────────────────────────────────────────────────────
test('stage 1 fires at 1 day overdue when never chased', () => {
  assert.equal(nextChaseStage({ days_overdue: 1, chase_stage: 0 }, DEFAULT_CADENCE, NOW), 1);
});
test('not due before stage1 threshold', () => {
  assert.equal(nextChaseStage({ days_overdue: 0, chase_stage: 0 }, DEFAULT_CADENCE, NOW), null);
});
test('stage 2 fires at 7 days once stage 1 sent + cooldown elapsed', () => {
  const last = new Date(NOW.getTime() - 7 * 86_400_000).toISOString();
  assert.equal(nextChaseStage({ days_overdue: 8, chase_stage: 1, last_chased_at: last }, DEFAULT_CADENCE, NOW), 2);
});
test('cooldown blocks a re-chase within 6 days of last send', () => {
  const last = new Date(NOW.getTime() - 3 * 86_400_000).toISOString();
  assert.equal(nextChaseStage({ days_overdue: 30, chase_stage: 1, last_chased_at: last }, DEFAULT_CADENCE, NOW), null);
});
test('stage 3 fires at 21 days from stage 2', () => {
  const last = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
  assert.equal(nextChaseStage({ days_overdue: 22, chase_stage: 2, last_chased_at: last }, DEFAULT_CADENCE, NOW), 3);
});
test('no stage beyond 3', () => {
  const last = new Date(NOW.getTime() - 30 * 86_400_000).toISOString();
  assert.equal(nextChaseStage({ days_overdue: 99, chase_stage: 3, last_chased_at: last }, DEFAULT_CADENCE, NOW), null);
});
test('snooze suppresses chasing until the snooze date', () => {
  const future = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
  assert.equal(nextChaseStage({ days_overdue: 30, chase_stage: 0, snoozed_until: future }, DEFAULT_CADENCE, NOW), null);
});
test('expired snooze no longer blocks', () => {
  const past = new Date(NOW.getTime() - 1 * 86_400_000).toISOString();
  assert.equal(nextChaseStage({ days_overdue: 5, chase_stage: 0, snoozed_until: past }, DEFAULT_CADENCE, NOW), 1);
});
test('custom cadence is honoured', () => {
  const cad = { stage1: 3, stage2: 10, stage3: 30, cooldown: 2 };
  assert.equal(nextChaseStage({ days_overdue: 2, chase_stage: 0 }, cad, NOW), null);
  assert.equal(nextChaseStage({ days_overdue: 3, chase_stage: 0 }, cad, NOW), 1);
});

// ── daysOverdue ──────────────────────────────────────────────────────────────
test('daysOverdue counts whole days past due', () => {
  assert.equal(daysOverdue('2026-06-13', NOW), 10);
  assert.equal(daysOverdue('2026-06-23', NOW), 0);
  assert.equal(daysOverdue('2026-06-30', NOW), -7); // not yet due
});

// ── safety keys ──────────────────────────────────────────────────────────────
test('phoneKey collapses SA formats to last 9 digits', () => {
  assert.equal(phoneKey('+27 82 410 3483'), '824103483');
  assert.equal(phoneKey('0824103483'), '824103483');
  assert.equal(phoneKey('27824103483'), '824103483');
  assert.equal(phoneKey('123'), null);
  assert.equal(phoneKey(null), null);
});
test('emailKey normalises + validates', () => {
  assert.equal(emailKey('  Foo@Bar.CO.ZA '), 'foo@bar.co.za');
  assert.equal(emailKey('notanemail'), null);
});

// ── money ────────────────────────────────────────────────────────────────────
test('amountTier buckets by value', () => {
  assert.equal(amountTier(500), 'low');
  assert.equal(amountTier(2500), 'medium');
  assert.equal(amountTier(15000), 'high');
});
test('formatMoney renders ZAR', () => {
  assert.ok(formatMoney(2500, 'ZAR').includes('2'));
});

// ── fallback message ─────────────────────────────────────────────────────────
test('fallback message escalates tone by stage + uses real names', () => {
  const base = { contactName: 'Sipho', invoiceNumber: 'INV-9', amount: 2500, daysOverdue: 8, senderName: 'Eden MediSpa' };
  const s1 = buildChaseFallback({ ...base, stage: 1 });
  const s3 = buildChaseFallback({ ...base, stage: 3 });
  assert.ok(s1.includes('Sipho'));
  assert.ok(/friendly/i.test(s1));
  assert.ok(s1.includes('Eden MediSpa'));
  assert.ok(/final notice/i.test(s3));
  assert.ok(!s1.includes('[') && !s3.includes('['), 'no bracketed placeholders');
});
test('fallback handles missing name', () => {
  assert.ok(buildChaseFallback({ amount: 100, daysOverdue: 1, stage: 1, senderName: 'X' }).includes('there'));
});

// ── reply classification ─────────────────────────────────────────────────────
test('classifies common replies', () => {
  assert.equal(classifyInvoiceReply('STOP'), 'stop');
  assert.equal(classifyInvoiceReply('please remove me'), 'stop');
  assert.equal(classifyInvoiceReply("I've paid already, EFT sent"), 'paid');
  assert.equal(classifyInvoiceReply('this invoice is wrong, I dispute it'), 'dispute');
  assert.equal(classifyInvoiceReply('can I pay you next week?'), 'snooze');
  assert.equal(classifyInvoiceReply('ok thanks'), 'unknown');
});
test('stop takes precedence over other words', () => {
  assert.equal(classifyInvoiceReply('stop, I already paid'), 'stop');
});

// ── date normalisation + CSV ─────────────────────────────────────────────────
test('normaliseDate handles common formats', () => {
  assert.equal(normaliseDate('2026-06-13'), '2026-06-13');
  assert.equal(normaliseDate('13/06/2026'), '2026-06-13');
  assert.equal(normaliseDate('2026/6/3'), '2026-06-03');
  assert.equal(normaliseDate('rubbish'), null);
});
test('parseInvoiceCsv reads flexible headers', () => {
  const csv = [
    'Invoice,Name,Phone,Email,Amount,Due Date',
    'INV-1,Sipho Dlamini,082 410 3483,sipho@x.co.za,2500,13/06/2026',
    'INV-2,"Acme, Ltd",,acme@x.co.za,R15 000,2026-06-01',
  ].join('\n');
  const { rows, errors } = parseInvoiceCsv(csv);
  assert.equal(errors.length, 0, 'no errors: ' + errors.join('; '));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].invoice_number, 'INV-1');
  assert.equal(rows[0].amount_due, 2500);
  assert.equal(rows[0].due_date, '2026-06-13');
  assert.equal(rows[1].contact_name, 'Acme, Ltd'); // quoted comma preserved
  assert.equal(rows[1].amount_due, 15000);         // currency symbols/spaces stripped
});
test('parseInvoiceCsv reports bad rows but keeps good ones', () => {
  const csv = [
    'invoice_number,contact_phone,amount_due,due_date',
    'INV-1,0824103483,2500,2026-06-13',
    'INV-2,,,,',                       // no contact, no amount
    'INV-3,0824103483,abc,2026-06-13', // bad amount
  ].join('\n');
  const { rows, errors } = parseInvoiceCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(errors.length, 2);
});

// ── email parsing ────────────────────────────────────────────────────────────
test('parseEmailMessage extracts Subject line + body', () => {
  const { subject, body } = parseEmailMessage('Subject: Payment reminder — INV-9\n\nHi Sipho,\nPlease settle R2,500.\n\nThanks, Eden');
  assert.equal(subject, 'Payment reminder — INV-9');
  assert.ok(body.startsWith('Hi Sipho,'));
  assert.ok(!/subject:/i.test(body));
});
test('parseEmailMessage defaults subject when absent', () => {
  assert.equal(parseEmailMessage('Hi, please pay.').subject, 'Invoice payment reminder');
});
test('buildChaseEmailHtml includes sender, body, STOP note; pay button only with url', () => {
  const noBtn = buildChaseEmailHtml({ senderName: 'Eden MediSpa', invoiceNumber: 'INV-9', body: 'Hi Sipho,\n\nPlease pay.' });
  assert.ok(noBtn.includes('Eden MediSpa'));
  assert.ok(noBtn.includes('Invoice INV-9'));
  assert.ok(/STOP/.test(noBtn));
  assert.ok(!noBtn.includes('Pay now'));
  const withBtn = buildChaseEmailHtml({ senderName: 'X', body: 'b', paymentUrl: 'https://pay.example/abc' });
  assert.ok(withBtn.includes('Pay now') && withBtn.includes('https://pay.example/abc'));
});

console.log(`\n${passed} chase tests passed ✅`);
