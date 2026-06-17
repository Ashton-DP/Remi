# ADR-0001: WhatsApp-first MVP architecture & build approach

- **Status:** Accepted
- **Date:** 2026-06-17
- **Deciders:** Ashton (founder), Claude (advisor)
- **Product:** Remi — an AI front desk for appointment-based clinics

## Context

Remi answers every call and WhatsApp enquiry for a clinic, books clients into the
calendar, reduces no-shows, backfills cancellations, and reports the revenue it
recovered. First market: **owner-run aesthetic & skin clinics in George and Cape Town,
South Africa**. Sold **done-for-you** (outcome, not software): free 2-week parallel
trial, then ~R3,000–8,000/month (or a cut of recovered revenue).

Constraints shaping the architecture:

- **WhatsApp dominates SA** (~94% of internet users use it). SMS is the secondary,
  "official" channel. The biggest revenue leak is *unanswered WhatsApp enquiries*,
  followed by missed phone calls.
- **POPIA** governs personal and health data; unsolicited electronic marketing requires
  prior consent (opt-out is not enough).
- **Fresha** is the common booking tool in SA spas/clinics but has no usable public API.
- Lean/solo builder. Need something **demoable in ~1 week** and a **paying pilot in ~3 weeks**.
- **WhatsApp Business sender approval** (via Meta) is a multi-day to ~2-week external
  dependency — it sits on the critical path.

## Decision

- **D1 — WhatsApp-first; defer live voice.** Build the WhatsApp booking brain first. A
  missed phone call triggers a WhatsApp follow-up. An AI that answers live phone calls is
  a later phase.
- **D2 — Stack.** Twilio (WhatsApp now, voice later) → Claude (conversation + tool-calling)
  → Supabase (conversations, bookings, leads, metrics) → a Remi-controlled calendar
  (Google Calendar or Cal.com) for the pilot.
- **D3 — Sandbox-first.** Build and test on Twilio's WhatsApp sandbox immediately; file the
  real WhatsApp Business sender approval on **day 1** so it lands before the pilot.
- **D4 — Shallow calendar for the pilot.** No deep Fresha two-way sync. Remi captures and
  confirms bookings on its own calendar and/or flags staff. Deeper integration only after
  the clinic is paying.
- **D5 — Claude as the brain, with tools:** `check_availability`, `create_booking`,
  `reschedule_booking`, `cancel_booking`, `escalate_to_human`. The system prompt carries
  the clinic's treatments, prices, hours, FAQs, and tone.
- **D6 — POPIA posture.** Replying to an inbound enquiry is a lawful service response, not
  marketing. The first message includes a brief consent/opt-in line. Store minimal personal
  data. Full consent management is only required when win-back/reactivation campaigns are
  switched on (deferred).
- **D7 — Delivery: done-for-you, run in parallel.** During the free 2-week trial, Remi
  handles overflow + after-hours only (zero risk to the clinic). Success metric = **rand
  recovered**, shown in a monthly report.
- **D8 — Human-in-the-loop fallback.** Anything Remi can't handle (complex, sensitive,
  angry, clinical) is escalated to the owner/staff.

## Consequences

**Positive:** demoable in ~1 week; paying pilot in ~3 weeks; reuses existing Supabase and
voice/messaging skills; low risk to clinics; WhatsApp-native = higher reply rates than SMS.

**Trade-offs:** the sandbox requires testers to opt in with a code (fine for testing, not
real clients); the shallow calendar means some manual steps early; WhatsApp sender approval
is on the critical path.

**Risks & mitigations:**
- WhatsApp approval delay → start day 1; build on the sandbox meanwhile.
- Fresha lock-in / no API → stay calendar-agnostic; favour clinics also on Acuity/Nookal
  (which have APIs).
- POPIA missteps → consent line + minimal data + defer marketing features.
- AI mishandles a conversation → human escalation + parallel (overflow-only) rollout.

## Alternatives considered

- **Voice-first** (the US-style version): rejected — harder to build, and WhatsApp is the
  dominant SA channel.
- **Meta WhatsApp Cloud API directly** instead of Twilio: viable, but Twilio chosen for
  speed, familiarity, and a unified voice + messaging stack.
- **Deep Fresha integration up front:** rejected — no public API, and premature before
  revenue.

## Open questions / follow-ups

- Exact pilot calendar: Google Calendar vs Cal.com.
- Validate ZAR pricing on the first discovery calls.
- POPIA data-handling specifics (storage location, retention, operator agreement with each
  clinic).
- Confirm the first pilot clinic (George shortlist — Dr Jean Aesthetics is the lead).

## Build slices (reference)

0. WhatsApp auto-booking MVP on the sandbox — **demoable**
1. Test hard + edge cases + human-handoff
2. No-shows (reminders/confirm) + waitlist backfill + "R recovered" report
3. First clinic live in parallel (real sender) — **pilot**
4. Voice agent + deeper calendar sync (later)
