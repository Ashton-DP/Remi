# Billing & Self-Serve Provisioning

How a customer goes from clicking a price on the website to a working dashboard,
and everything you need to operate / test / troubleshoot it.

## The flow at a glance

```
Website pricing button
  → Stripe Checkout (14-day trial, card collected, R0 today)
  → Stripe fires checkout.session.completed → /webhooks/stripe
  → Remi: create clinic (with the right plan) + owner login + welcome email
  → Customer signs in at /app and sees the dashboard for the tier they bought
  → Later: subscription.* / invoice.* events keep status in sync (dunning, etc.)
```

## Tiers, products & payment links

Products + recurring ZAR prices + Payment Links live in **your** Stripe account.
Created by `scripts/setupStripePlans.mjs` (charge-immediately) and
`scripts/createTrialLinks.mjs` (14-day trial — these are what the website uses).

| Tier      | Price     | Dashboard plan key | Trial link (live)                                   |
|-----------|-----------|--------------------|-----------------------------------------------------|
| PaidUp    | R299/mo   | `paidup`           | https://buy.stripe.com/28E8wO7hD38R3bHd8s57W09      |
| Basic     | R990/mo   | `basic`            | https://buy.stripe.com/cNidR8fO97p79A55G057W0a      |
| Standard  | R2,900/mo | `standard`         | https://buy.stripe.com/6oU6oGcBX4cV3bHc4o57W0b      |
| Complete  | R6,500/mo | `complete`         | https://buy.stripe.com/fZufZg0TfgZHeUpc4o57W0c      |
| Chains    | custom    | `complete`         | quoted manually — no fixed link                     |

The website buttons (`public/index.html`, the `.plan-btn` anchors) point at the
**trial** links. The non-trial links are kept in `~/Desktop/remi-payment-links.txt`
for sending to a customer who skips the trial.

> ⚠️ Re-running `setupStripePlans.mjs` creates **duplicate** products. If that
> happens, use `scripts/cleanupStripeDuplicates.mjs`.

## Plan → dashboard mapping

A clinic's `plan` column decides which screens it sees. Defined in
`dashboard/src/components/Shell.tsx` (`PLAN_NAV`):

- `paidup`   → Get Paid, Team, Settings
- `basic`    → Appointments, Team, Settings
- `standard` → Ask Remi, Today, Inbox, Appointments, Customers, Team, Settings
- `complete` → everything

Unknown/missing plan falls back to `complete` (so pre-billing clinics keep full access).

## Stripe webhook setup

**Endpoint:** `https://www.remireception.com/webhooks/stripe`

**Events to subscribe** (or just select all `customer.subscription.*` + all
`invoice.*` + `checkout.session.completed`):

| Event                                   | Handler does                                              |
|-----------------------------------------|----------------------------------------------------------|
| `checkout.session.completed`            | **Provision** clinic + login + welcome email             |
| `customer.subscription.created`         | sync `subscription_status`                                |
| `customer.subscription.updated`         | sync `subscription_status`                                |
| `customer.subscription.paused`          | sync `subscription_status` (→ `paused`)                   |
| `customer.subscription.resumed`         | sync `subscription_status` (→ `active`/`trialing`)        |
| `customer.subscription.deleted`         | sync `subscription_status` (→ `canceled`)                 |
| `customer.subscription.trial_will_end`  | email the clinic ~3 days before trial converts           |
| `invoice.payment_failed`                | mark clinic `past_due` + email to update card            |
| `invoice.paid`                          | re-assert live status (recovers `past_due`) + ops log    |
| `customer.updated`                      | ignored (harmless)                                        |

After creating the endpoint, copy its **Signing secret** (`whsec_…`) into Railway
as `STRIPE_WEBHOOK_SECRET`.

Subscribing to an event with no handler is harmless — the webhook returns 200 and
ignores it.

## Required environment variables (Railway)

| Var                     | Used for                                              |
|-------------------------|------------------------------------------------------|
| `STRIPE_SECRET_KEY`     | line-item lookup, tagging subscriptions, etc.        |
| `STRIPE_WEBHOOK_SECRET` | verifying webhook signatures (the `whsec_…`)         |
| `RESEND_API_KEY`        | sending welcome + dunning emails (logs if missing)   |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` | clinic + auth user creation          |
| `PUBLIC_BASE_URL`       | dashboard link in emails (default remireception.com) |

## Database

Provisioning needs the `plan` column on `clinics`:

```sql
alter table clinics add column if not exists plan text default 'complete';
notify pgrst, 'reload schema';
```

(Migration file: `db/migrate_plan.sql`. Already applied in production.)

## How provisioning works (idempotent)

`src/lib/provisionClinic.ts → provisionFromCheckout(session)`:

1. Read buyer email/name/phone from the checkout session.
2. Map the purchased product → plan (`PLAN_BY_PRODUCT`; highest tier if multiple).
3. If the buyer already has a Remi user **and** a clinic → just re-sync the plan +
   re-tag the subscription (no duplicate, no second email). Otherwise:
4. Create the clinic (`plan`, `subscription_status`), stamp `clinic_id` onto the
   Stripe subscription metadata (so later `subscription.*` events map back),
   create a Supabase auth user (owner), link it, and email the login.

Failures return HTTP 500 so Stripe retries — and retries are safe (step 3).

## Testing

### Quick signature check (no data created)
Stripe Dashboard → endpoint → **Send test event** → `checkout.session.completed`.
Expect **200**. (The sample is `mode: payment`, so provisioning is skipped — this
only proves the signing secret matches.) A 400 means `STRIPE_WEBHOOK_SECRET` is
wrong/missing.

### Full end-to-end (free — trial charges R0 today)
1. Open a trial link (e.g. Basic) in an incognito window.
2. Complete checkout with a real email + card (no charge during trial).
3. Verify: welcome email arrives → sign in at `/app` → dashboard matches the tier.

### Cleanup after a test
- Cancel the subscription in Stripe (or `stripe.subscriptions.cancel`).
- Delete the test clinic row + the Supabase auth user (service key).

## Troubleshooting

- **Nothing happens after checkout** → is `checkout.session.completed` subscribed?
  It's in the **Checkout** section of the event picker, not Customer.
- **Webhook returns 400** → `STRIPE_WEBHOOK_SECRET` doesn't match the endpoint.
- **Clinic created but no login email** → `RESEND_API_KEY` missing (check logs;
  the temp password is logged when email isn't configured).
- **Wrong dashboard after sign-in** → product name no longer matches
  `PLAN_BY_PRODUCT` in `provisionClinic.ts` (e.g. a product was renamed). The
  fallback is `basic`.
- **Insert fails** → confirm the `plan` column exists (migration above).

## Key files

- `src/routes/stripeWebhook.ts` — webhook entry; routes events to handlers
- `src/lib/provisionClinic.ts` — checkout → clinic + login + email
- `src/lib/billingNotifications.ts` — trial_will_end / payment_failed / invoice.paid
- `src/lib/stripe.ts` — client + signature verification
- `scripts/setupStripePlans.mjs`, `scripts/createTrialLinks.mjs` — link creation
- `dashboard/src/components/Shell.tsx` — plan → dashboard mapping
