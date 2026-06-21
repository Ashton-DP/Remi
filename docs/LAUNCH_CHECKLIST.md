# Remi — End-to-End Launch Checklist

Everything required to take Remi from "works in a demo" to "a functioning product
you can sell and run". Organised by **priority tier** so you can see the critical
path to your first paying clinic vs. what's needed to scale safely.

Status legend: ✅ done · 🟡 in progress / partial · ⬜ not started

---

## TIER 0 — Critical path to your FIRST paying clinic
The minimum to legally and technically run one real clinic and get paid.

### A. Telephony & WhatsApp (the "front door")
- 🟡 **SA +27 phone number** — finish Twilio regulatory bundle (proof of address + CoR15.1A). ~7-day review. *Blocking everything below.*
- ⬜ **Register the number as a WhatsApp Sender** (Twilio embedded signup → creates the WABA).
- ⬜ **Meta business verification** — auto-triggers during sender setup; verify the SA company (CoR15.1A ready).
- ⬜ **Submit the 9 WhatsApp templates** (Content Template Builder) → wait for approval → paste Content SIDs into `WA_TEMPLATE_*` env vars. *(All 9 finalised + code-wired — see docs/whatsapp-templates.md. Note: `reactivation_winback` is MARKETING + consent-gated; the rest are UTILITY.)*
- ⬜ **Test voice end-to-end** — point the number's voice webhook to `/webhooks/voice/inbound`; call it, confirm Remi answers, books, and the missed-call → WhatsApp fires. *(Built, never tested — no number yet.)*
- ⬜ **Set the WhatsApp number's inbound webhook** to `https://<prod-url>/webhooks/whatsapp` (the real sender page, not the sandbox).

### B. Booking system integration (the single biggest product gap)
Remi connects to whatever booking system a clinic uses, via a **provider-agnostic
adapter layer** (`src/lib/booking/`). The booking flow (slots + create/reschedule/
cancel) only talks to the `BookingProvider` interface — adding a system is one new
file + one registry line, no flow changes.
- ✅ **Provider abstraction built** — `BookingProvider` interface, `getBookingProvider(clinic)` registry (keys off `clinics.booking_provider`, defaults to Google, falls back safely for unbuilt providers). Migration: `db/migrate_booking_provider.sql`. Tests: `npm test` (10 passing).
- ✅ **Google Calendar adapter** — the universal default; per-clinic calendar via `clinics.google_calendar_id`. **Now also moves the event on reschedule and deletes it on cancel** (previously only the DB was updated — real bug, fixed).
- ✅ **Real availability logic** — `computeFreeSlots` reads the provider's busy windows; no double-booking, timezone-correct.
- 🟡 **Acuity / Cliniko / Nookal adapters built** — real API integrations (`src/lib/booking/*Provider.ts`), written against each vendor's published API. **Untested against live accounts** — do an end-to-end test (availability → book → reschedule → cancel) with real credentials before a clinic goes live on one. Config per clinic: `db/migrate_booking_provider.sql` + `docs/booking-providers.md`.
- ⬜ **Confirm the pilot clinic's booking tool** (Fresha dominates SA spas; allied-health uses Nookal/Acuity/Cliniko; medical uses GoodX/Healthbridge).
- ⬜ **Fresha** has no usable public API → run that clinic on the Google adapter mirroring their diary. **GoodX** needs a partner/contract integration (not built). Any clinic can run on Google today.

### C. Compliance & legal (non-negotiable for health data)
- 🟡 **POPIA Operator Agreement** — at `docs/legal/POPIA_OPERATOR_AGREEMENT.md`. Operator name filled (The Visionaries (Pty) Ltd), sub-operators corrected (Railway, ElevenLabs). **Remaining:** CIPC reg no., Supabase region, attorney review, sign per clinic.
- ⬜ **Register an Information Officer** for your SA company with the Information Regulator (free, online). *(Ashton de Pontes named as IO in the policy; still needs Regulator registration.)*
- 🟡 **Privacy Policy** — ✅ **published & live at `/privacy`** (linked in footer); filled with known details. **Remaining:** CIPC reg no., Information Regulator reference, attorney review.
- 🟡 **Terms of Service** — ✅ **published & live at `/terms`** (`docs/legal/TERMS_OF_SERVICE.md`); linked in footer. **Remaining:** CIPC reg no., attorney review.
- 🟡 **Client Order Form / Service Agreement** — *draft ready* at `docs/legal/CLIENT_ORDER_FORM.md` (the B2B contract clinics sign — scope, price, trial, cancellation; incorporates ToS + Operator Agreement). Fill per-clinic placeholders + attorney review. *(Also satisfies Tier 0-D "client agreement / order form".)*
- ⬜ **Consent line on first contact** — already in code ("By replying you're happy for us to message you about your booking"). Confirm it's POPIA-sufficient for service messages; add explicit opt-in if you ever do reactivation/marketing.
- ⬜ **STOP/opt-out handling** — already in code; confirm it logs and suppresses future sends.
- ⬜ **Switch off Gemini free tier** → paid Gemini or Claude. The free tier may train on prompts = a POPIA breach for patient data. *(Flip `AI_PROVIDER`/keys before ANY real patient traffic.)*

### D. Get paid
- ⬜ **Choose a payment processor** — Stitch or Peach for recurring debit orders (Paystack if you prefer card + best APIs).
- ⬜ **Set up recurring billing** for the R2,500 / R4,500 / R6,500 tiers.
- 🟡 **Client agreement / order form** — *draft ready* at `docs/legal/CLIENT_ORDER_FORM.md` (scope, price, 2-week trial, cancellation). Fill per-clinic + attorney review.
- ⬜ **Invoicing + VAT** — confirm with your accountant whether the SA company must register for VAT yet.

### E. Make the deployment production-safe
- ✅ **Hosting on Railway** (always-on, no cold-start sleep). **Remaining:** decommission the old Render `remi` service + downgrade the Render workspace to Hobby to stop the $25 (check no other Render service needs Pro first).
- ✅ **Reminders now run** — the scheduler runs **in-process** on the web service (env `RUN_SCHEDULER`, default on). *At multi-instance scale*, set `RUN_SCHEDULER=false` on web and run one dedicated Background Worker (`node dist/scheduler.js`) to avoid duplicate sends.
- ✅ **Twilio webhook signatures validated** — `validateTwilioWebhook` middleware on all `/webhooks/*` (unsigned POSTs now return 403; `TWILIO_SKIP_VALIDATION=true` bypasses for testing).
- ⬜ **Rotate the leaked secrets** — Supabase service_role key + Twilio auth token were shown in chat. Rotate both; update Railway + `.env`.
- ✅ **Custom domain** — `www.remireception.com` live (Cloudflare → Railway; apex 301→www).

---

## TIER 1 — Production hardening (before scaling past clinic #1)

### Reliability & safety
- 🟡 **Error monitoring** — built (`src/lib/monitoring.ts`): Express error handler + process crash handlers + optional Slack/webhook alerts, all wired. **To turn on:** set `MONITORING_WEBHOOK_URL` (works now, no deps) and/or `SENTRY_DSN` + `npm i @sentry/node`.
- ⬜ **Uptime monitoring** — point UptimeRobot (or similar) at `GET /health` + alert. *(Endpoint exists; just needs the external monitor — your account.)*
- ⬜ **Structured logging** — keep request/AI logs for debugging + the "$ recovered" audit trail.
- ✅ **Idempotency** — inbound WhatsApp deduped on MessageSid via `processed_messages` (Twilio webhook retries no longer double-book/double-reply). Fails open.
- ⬜ **Rate limiting / abuse protection** on public webhooks (AI calls cost money).
- ⬜ **Supabase backups + data-retention policy** (POPIA: don't keep data longer than needed).
- ✅ **Graceful AI fallback** — `runAgent` escalates to a human + sends a warm hand-off when the AI provider errors/rate-limits, instead of dropping the lead.

### Quality
- 🟡 **Automated tests** — 31 tests across 4 suites (`npm test`): booking provider/registry + slot logic, dashboard auth, AI fallback, report math + reminder scheduling. Still to add: end-to-end booking-provider tests vs live accounts, prompt/edge-case coverage.
- ⬜ **Prompt hardening** — handle edge cases (ambiguous dates, multiple services, out-of-hours, "speak to a human", pricing haggling, non-English).
- ⬜ **Afrikaans + multilingual QA** on both WhatsApp and voice.
- ⬜ **Voice quality pass** — TTS naturalness, interruption handling, "didn't catch that" loops, accidental hang-ups.

### The retention metric
- 🟡 **"R recovered" monthly report** — exists; make it the polished artifact you email each clinic (this is what prevents churn). Auto-send monthly.
- ✅ **Per-clinic dashboard access** — token-gated, fail-closed (`DASHBOARD_TOKEN` master + optional per-clinic `dashboard_token`). HttpOnly cookie, constant-time compare.

---

## TIER 2 — Scale, polish & growth

### Onboarding & ops
- 🟡 **Onboarding flow** — `npm run onboard` CLI exists; turn into a repeatable runbook (or self-serve form): clinic info, hours, services, FAQs, booking-system connection, number assignment, templates.
- ⬜ **Multi-number / multi-clinic at scale** — each clinic ideally gets its own WhatsApp sender + display name; routing already keys off `twilio_number`.
- ⬜ **Support process** — how clinics reach you; SLA; who fixes a broken booking at 9pm.
- ⬜ **Internal admin** — view/override conversations, re-send a confirmation, refund a billing error.

### Product depth (the upsell path)
- ⬜ Reactivation/recall campaigns (needs explicit POPIA consent).
- ⬜ Review generation (Google reviews after a visit).
- ⬜ Digital intake forms.
- ⬜ Card-on-file / deposits to cut no-shows further.
- ⬜ Reporting analytics (trends, busiest times, conversion).

### Go-to-market
- 🟡 **Landing page** — live; add Privacy/Terms, a real demo video/GIF, social proof once you have it.
- ⬜ **Sales collateral** — one-pager, pricing sheet, the discovery-call script (saved in memory), case study after clinic #1.
- ⬜ **Demo environment** — a safe sandbox clinic you can show prospects from your phone anytime.
- ⬜ **First 10 clinics pipeline** — Cape Town aesthetics (50+ on Fresha), George (Eden MediSpa, etc.).

---

## Rough unit economics (so the tiers stay profitable)
Per clinic / month, approximate:
- Twilio number rental: ~$1–15
- WhatsApp messages: in-window replies **free**; utility templates **cheap** (cents); only marketing is pricey — Remi is mostly free/cheap here
- Voice: Twilio per-minute + TTS/STT (only if voice answering is on)
- AI (Gemini paid / Claude): cents per conversation
- Hosting: Render paid (~$7+) + Supabase (free → $25 Pro) — **shared across all clinics**, not per-clinic
- Payment processor: ~2–3% of the subscription

At R2,500–6,500/clinic/month, variable cost per clinic is small (low hundreds of Rand) → healthy margin. Watch voice minutes and AI tokens as the main variable costs.

---

## The honest "can I sell it tomorrow?" answer
**Critical path = Tier 0.** In rough order:
1. SA number → WhatsApp sender → templates approved
2. Connect the pilot clinic's real booking system
3. POPIA operator agreement + Information Officer + privacy policy + paid AI tier
4. Payment collection set up
5. Render paid + scheduler worker + webhook signature validation + rotate keys

Everything in Tier 1/2 makes it *safe to scale and hard to churn* — but Tier 0 is
what stands between you and clinic #1's first invoice.

---

*Sources: [Meta WhatsApp pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) · [Twilio regulatory bundles](https://help.twilio.com/articles/8338625205147-How-to-Submit-a-Regulatory-Bundle-for-Phone-Number-Regulatory-Compliance) · [POPIA Information Officers (Bowmans)](https://bowmanslaw.com/insights/popia-what-you-need-to-know-about-the-appointment-and-registration-of-information-officers/) · [POPIA health data](https://captaincompliance.com/education/south-africas-popia-health-data-rules/) · [Stitch recurring payments](https://stitch.money/solutions/recurring-payments) · [Peach recurring billing](https://www.peachpayments.com/products/subscription-payments-recurring-billing)*
