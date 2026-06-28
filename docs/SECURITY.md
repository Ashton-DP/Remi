# Security model & operations

How Remi protects tenant data, money, and spend — and the env vars you set to run
it safely. Audited 2026-06 (see git history `fix(security): …` / `fix: audit fixes`).

## Authentication & multi-tenancy

- **Dashboard API (`/api/*`):** every route is behind `requireApiAuth`
  (`src/lib/apiAuth.ts`). Identity comes from a Supabase-issued JWT, verified
  server-side with `supabase.auth.getUser(token)`. The caller's `clinicId` and
  `role` are resolved **server-side** from `clinic_users` — never trusted from the
  request — so a caller cannot assert their own clinic or role.
- **Tenant isolation:** every id-taking handler re-checks the resource belongs to
  `auth.clinicId` before reading/mutating (no IDOR). The Supabase client uses the
  **service key**, which bypasses RLS — so isolation depends on these app-level
  checks. Keep them on every new endpoint.
- **RLS** is additionally enabled on all tenant tables in the live project (see
  `memory/rls-enabled-in-supabase.md`). It is NOT set by any migration — it lives
  in Supabase config. If you add tables via raw SQL, verify RLS is enabled on them.
- **Roles:** admin/owner-only actions use `roleAtLeast('admin'|'owner')`.
- **Platform-admin god-view** (`/api/admin/*`) is behind `requirePlatformAdmin`
  (checks the `platform_admins` table).
- **Public token-gated pages** (`/dashboard/:id`, `/report/:id`) use
  `requireDashboardAuth` (constant-time token compare, fail-closed). Public
  capability links (`/pay/:id`, `/membership/:id`, intake) use unguessable UUIDs /
  HMAC tokens.

## Secrets at rest — encryption

Per-clinic **payment credentials** (Stripe/Paystack secret keys, PayFast
passphrase + merchant key, PayPal secret), the **email-inbox app-password**, and
**OAuth invoice-source tokens** (Xero/QBO/Sage) are encrypted at rest with
AES-256-GCM (`src/lib/secretCrypto.ts`). Encryption happens at the db.ts boundary:
encrypt on write, decrypt transparently when a clinic is loaded.

**Opt-in / safe-by-default:** with **no** `PAYMENT_ENC_KEY` set it is a no-op
(plaintext, unchanged behaviour). To turn it on:

1. Generate a 32-byte key: `openssl rand -hex 32`
2. Set `PAYMENT_ENC_KEY=<that hex>` (or base64) in the deploy env (Railway), redeploy.
3. **Migrate existing rows:** re-save each clinic's payment config / email inbox /
   accounting connection once (re-enter in Settings) so the existing **plaintext**
   values get encrypted. New writes encrypt automatically; legacy plaintext keeps
   reading in the meantime (values are tagged `enc:v1:`, so mixed state is fine).

**Rotation:** there is no automated re-encrypt. To rotate the key you must decrypt
with the old key and re-encrypt with the new one (re-save each clinic, or write a
one-off migration). Do not lose the key — encrypted secrets become unrecoverable.

Payment/inbox secrets are **never** returned in any API response (only the provider
*name* / inbox *user* is exposed).

## Rate limiting & spend protection

In-memory limiters (`src/lib/rateLimit.ts`; move to Redis if you run >1 instance):

| Env var | Default | Protects |
|---|---|---|
| `RL_WEBHOOK_MAX` | 300/min/IP | all Twilio webhooks (defence-in-depth; Twilio shares IPs) |
| `RL_INBOUND_MAX` | 15/min/**phone** | inbound WhatsApp/SMS brain (paid LLM + sends) |
| `RL_VOICE_MAX` | 40/min/**CallSid** | voice inbound/gather |
| `RL_ASSISTANT_MAX` | 20/min/**user** | `/api/assistant` copilot |
| `RL_PAY_MAX` | 20/min/IP | `/pay/:id`, `/membership/:id/start` (billable provider calls) |
| `RL_TOOLS_MAX` | 60/min/IP | `/tools/:tool` |

**Voice session caps** (stop a held-open call billing forever):
`MAX_CALL_MINUTES` (default 15) and `MAX_CALL_TURNS` (default 40, conversationrelay).

## Webhook authenticity

Every state-mutating webhook verifies the sender before acting:
- **Twilio** (`/webhooks/whatsapp|sms|voice/*`): request-signature validated,
  fail-closed in production.
- **Stripe billing** (`/webhooks/stripe`): signature via `constructWebhookEvent`;
  raw body is mounted before the JSON parser — keep that order.
- **PayFast ITN** (`/webhooks/payfast`): rejected if the clinic has **no
  passphrase**; signature validated (constant-time); the invoice **amount** is
  checked against `amount_due` before marking paid.
- **Payment returns** (Stripe/Paystack/PayPal): the transaction is re-verified
  server-side via the provider API — query params alone never mark an invoice paid.

## Operator / agent endpoints

- **`CHASE_IMPORT_TOKEN`** (or `ONBOARD_TOKEN`) gates the operator endpoints
  (invoice import, connect a source, email-domain). Pass it via the
  **`X-Chase-Token` header** — `?token=` query still works but leaks into access
  logs. NOTE: this is a single shared secret across tenants; treat it as an
  operator credential.
- **`TOOLS_SHARED_SECRET`** gates `/tools/:tool` (the ElevenLabs agent's real
  booking actions). Fails **closed** in every deployed environment when unset —
  only `TOOLS_ALLOW_INSECURE=true` opts in locally. Pass via `X-Tool-Secret`.
- **`INTAKE_SECRET`** (falls back to `TOOLS_SHARED_SECRET`) signs intake-form +
  connect-state HMAC links. Always set one in production.

## Data protection (POPIA)

- **Retention purge** (daily): messages/conversations older than `RETENTION_DAYS`
  (default 730 = 24 months) are deleted; booking/audit rows kept.
- **Opt-out:** customers replying `STOP` are added to the `suppressions` list and
  marketing sends (`sendMarketingWhatsApp`) skip them; `START` re-opts-in.
  Transactional sends (reminders, deposits) are exempt by design.
- Customer PII does go to the LLM provider (Gemini/Claude) for the receptionist
  function — disclose this in the privacy policy. No analytics/telemetry sends PII.

## Required production env (set on Railway)

`NODE_ENV=production` · `SUPABASE_URL` · `SUPABASE_SERVICE_KEY` ·
`TWILIO_ACCOUNT_SID` · `TWILIO_AUTH_TOKEN` · an AI key (`GEMINI_API_KEY` or
`ANTHROPIC_API_KEY`) · `STRIPE_WEBHOOK_SECRET` · `DASHBOARD_TOKEN` /
`TOOLS_SHARED_SECRET` / `INTAKE_SECRET` · `MONITORING_WEBHOOK_URL` (alerting) ·
**`PAYMENT_ENC_KEY`** (to encrypt secrets at rest) · `PAYFAST_SANDBOX` must NOT be
`true`.

## Known open items (not blockers)

- The shared `CHASE_IMPORT_TOKEN` is not per-clinic (operator credential). A
  per-clinic-token rework would be the proper fix.
- `getUserClinic` pins a multi-clinic user to their oldest clinic (no switcher).
- Key rotation for `PAYMENT_ENC_KEY` is manual (re-save to re-encrypt).
