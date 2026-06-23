// Invoice-source pure mapper tests. Run: tsx tests/invoiceSources.test.ts
import assert from 'node:assert';
import {
  mapXeroInvoice, mapQboInvoice, mapSageInvoice, isSageChaseable,
  assemblePhone, toDateOnly, daysOverdue, type NormalizedInvoice,
} from '../src/lib/invoiceSources/mappers';

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e: any) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exit(1); }
}
const NOW = new Date('2026-06-23T08:00:00Z');

console.log('invoice sources — pure mappers');

function assertNormalized(n: NormalizedInvoice) {
  assert.ok(n.external_id, 'external_id');
  assert.ok(n.invoice_number, 'invoice_number');
  assert.ok(typeof n.amount_due === 'number' && n.amount_due >= 0, 'amount_due');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(n.due_date), 'due_date YYYY-MM-DD');
}

// ── helpers ──────────────────────────────────────────────────────────────────
test('toDateOnly handles Date and ISO string', () => {
  assert.equal(toDateOnly(new Date('2026-06-13T10:00:00Z')), '2026-06-13');
  assert.equal(toDateOnly('2026-06-13T00:00:00+02:00'), '2026-06-13');
  assert.equal(toDateOnly(null), null);
});
test('daysOverdue never negative', () => {
  assert.equal(daysOverdue('2026-06-13', NOW), 10);
  assert.equal(daysOverdue('2026-07-01', NOW), 0);
});
test('assemblePhone prefers mobile and builds +cc ac num', () => {
  assert.equal(assemblePhone([
    { phoneType: 'DEFAULT', phoneCountryCode: '27', phoneAreaCode: '21', phoneNumber: '5551234' },
    { phoneType: 'MOBILE', phoneCountryCode: '27', phoneAreaCode: '82', phoneNumber: '4103483' },
  ]), '+27824103483');
  assert.equal(assemblePhone([]), null);
  assert.equal(assemblePhone(null), null);
});

// ── Xero ─────────────────────────────────────────────────────────────────────
test('mapXeroInvoice maps fields + merges contact', () => {
  const n = mapXeroInvoice(
    { invoiceID: 'x-1', invoiceNumber: 'INV-100', contact: { name: 'Sipho' }, amountDue: 2500, currencyCode: 'ZAR', dueDate: new Date('2026-06-13T00:00:00Z') },
    { email: 'sipho@x.co.za', phone: '+27824103483' },
  );
  assertNormalized(n);
  assert.equal(n.invoice_number, 'INV-100');
  assert.equal(n.contact_email, 'sipho@x.co.za');
  assert.equal(n.contact_phone, '+27824103483');
  assert.equal(n.amount_due, 2500);
  assert.equal(n.due_date, '2026-06-13');
});
test('mapXeroInvoice falls back invoice_number → id, handles PascalCase', () => {
  const n = mapXeroInvoice({ InvoiceID: 'x-2', AmountDue: 99, DueDate: '2026-06-01' });
  assert.equal(n.external_id, 'x-2');
  assert.equal(n.invoice_number, 'x-2');
  assert.equal(n.contact_name, 'Unknown');
});

// ── QuickBooks ───────────────────────────────────────────────────────────────
test('mapQboInvoice maps Balance/DocNumber/BillEmail', () => {
  const n = mapQboInvoice({ Id: '42', DocNumber: 'QB-7', CustomerRef: { name: 'Acme' }, BillEmail: { Address: 'ap@acme.co.za' }, Balance: 15000, CurrencyRef: { value: 'ZAR' }, DueDate: '2026-06-01' });
  assertNormalized(n);
  assert.equal(n.invoice_number, 'QB-7');
  assert.equal(n.contact_name, 'Acme');
  assert.equal(n.contact_email, 'ap@acme.co.za');
  assert.equal(n.contact_phone, null);
  assert.equal(n.amount_due, 15000);
});
test('mapQboInvoice uses Id when DocNumber blank', () => {
  assert.equal(mapQboInvoice({ Id: '99', Balance: 1, DueDate: '2026-06-01' }).invoice_number, '99');
});

// ── Sage ─────────────────────────────────────────────────────────────────────
test('isSageChaseable: only unpaid + overdue', () => {
  assert.equal(isSageChaseable({ status: { id: 'OUTSTANDING' }, due_date: '2026-06-01' }, '2026-06-23'), true);
  assert.equal(isSageChaseable({ status: { id: 'PAID' }, due_date: '2026-06-01' }, '2026-06-23'), false);
  assert.equal(isSageChaseable({ status: { id: 'OUTSTANDING' }, due_date: '2026-07-01' }, '2026-06-23'), false);
  assert.equal(isSageChaseable({ status: 'PART_PAID', due_date: '2026-06-01' }, '2026-06-23'), true);
});
test('mapSageInvoice maps outstanding_amount + contact', () => {
  const n = mapSageInvoice({ id: 's-5', invoice_number: 'SG-5', contact: { displayed_as: 'Lebo', email: 'lebo@x.co.za', mobile_telephone: '0824103483' }, outstanding_amount: 1200, currency: { id: 'ZAR' }, due_date: '2026-06-01' });
  assertNormalized(n);
  assert.equal(n.invoice_number, 'SG-5');
  assert.equal(n.contact_name, 'Lebo');
  assert.equal(n.contact_phone, '0824103483');
  assert.equal(n.amount_due, 1200);
});

console.log(`\n${passed} invoice-source tests passed ✅`);
