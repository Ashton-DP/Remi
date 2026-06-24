# Remi Master Dashboard — Product & Technical Spec

_Status: PLAN (2026-06-23). The unified "command centre" that merges the Remi
(front-desk) and PaidUp (get-paid) surfaces into one place a subscriber logs into
to see, control, and override everything the AI does._

---

## 1. Vision & principles

Today Remi runs invisibly in the background. The dashboard makes it a **product
people use**: a subscriber's base of operations where the AI's work is fully
visible and controllable. It's also the foundation for the north-star direction
([[remi-operator-os-vision]]) where the receptionist becomes a Remi *operator*.

**Operating model: human-on-the-loop.** Remi acts autonomously; the human
monitors and keeps veto power. Every automated behaviour must be:
1. **Visible** — you can see exactly what Remi did and is about to do.
2. **Pausable** — a clear off switch at every level (global, per-system, per-item).
3. **Overridable** — the human can step in, correct, or take over any time.

Design tenets (from current human-in-the-loop UX practice):
- **A "Needs you" queue**, not a firehose of alerts — decision support, not noise.
- **Progressive disclosure** — a calm overview that drills into detail on demand.
- **Show the ROI** — the "revenue recovered / bookings saved" number is the
  anti-churn artifact and should be front and centre.
- **No automation complacency** — surface what Remi is *unsure* about, not just
  what it did confidently.
- Regulatory tailwind: EU AI Act Art.14 + POPIA both expect human-oversight
  surfaces — building this well is also compliance.

---

## 2. Platform decision — web-first PWA, native later

**Decision: one responsive web app, packaged as a PWA. Not native-first.**

Why (precedent-backed):
- Front desks are screen-based; operational dashboards are overwhelmingly
  web-first (Fresha, Cliniko, Stripe, Intercom, Linear).
- A PWA is installable to the home screen, supports push notifications (iOS 16.4+,
  ~94% of iPhones in 2026), works offline, and updates instantly with no app-store
  review — at ~30% the cost of native, one codebase.
- Native is only justified for Bluetooth/NFC/AR/background-GPS — none of which
  Remi needs.
- Upgrade path: if real demand appears, wrap the same web app as native with
  **Capacitor** (reuse 100% of the code) rather than building twice.

**Result:** same URL is the desktop dashboard AND the "Remi app" on a phone.

---

## 3. Information architecture (top-level nav)

A single left-nav shell. Sections:

1. **Today (Home)** — live pulse. Today's appointments, calls/messages handled,
   R recovered, invoices chased/paid, and a **"Needs you"** strip (escalations,
   disputes, failed sends). The morning huddle as a screen.
2. **Inbox / Conversations** — every call + WhatsApp/SMS Remi handled, with full
   transcripts. Take over / jump in / correct a reply. This is the core
   supervision surface (and the seed of the operator-OS).
3. **Bookings** — calendar of appointments Remi made; reschedules, no-shows,
   waitlist; manual add/edit.
4. **Get Paid** (PaidUp) — invoices with per-invoice **chase timeline** (which
   stage, when, on which channel, opened/paid), filters (overdue/paid/disputed/
   snoozed), and controls: pause chasing (kill switch), snooze, mark paid, edit
   cadence, connected accounting source + sync status, payment-provider status.
5. **Customers** — contact list, history across bookings + invoices + convos,
   consent/opt-out status.
6. **Insights** — conversion rate, after-hours %, busiest day, top service, and
   the headline **revenue-recovered** report (live + monthly).
7. **Settings** — services, hours, knowledge/brand voice, channels, payment
   provider, **email white-label domain onboarding** (wraps the Resend API flow),
   team/users, billing/subscription.

Cross-cutting: a global **"Pause Remi"** master switch and a **search**.

---

## 4. What you see + control, per system (the merge)

| System | See | Control |
|---|---|---|
| Calls/messages | Transcripts, outcomes, after-hours catches | Take over, correct, block a number |
| Bookings | What was booked/moved/cancelled | Add/edit/cancel, manage waitlist |
| No-shows | Reminder sequence status | Toggle, edit timing, deposits |
| Invoices (PaidUp) | Per-invoice chase timeline + status | Pause/snooze/mark-paid/dispute, edit cadence |
| Invoice sources | Sync status per provider | Connect Xero/QBO/Sage/Sheet, sync now |
| Payments | Which provider, paid links, what's paid | Connect provider, copy pay link |
| Email identity | Send-on-behalf vs white-label, domain status | Provision + verify own domain |
| Outreach | Reactivation, reviews, follow-ups | Toggle each, set rules |
| Escalations | What Remi flagged for a human | Resolve, reply, reassign |

Everything already has a backend method/endpoint from the chase + front-desk work
— the dashboard is largely a UI over existing capability, plus auth.

---

## 5. Technical architecture

- **Frontend:** a single-page app (**React + Vite + TypeScript**, Tailwind),
  PWA-enabled (manifest + service worker, web push). Talks to the Remi API.
- **API:** extend the existing Express backend with a versioned JSON API
  (`/api/...`) covering read views + control actions. Reuse existing db.ts methods.
- **Realtime:** Supabase Realtime subscriptions (or SSE) so the Inbox/Today update
  live as Remi works.
- **Auth & multi-tenancy (the prerequisite — currently missing):** today the
  dashboard is a per-clinic URL token. A real product needs **proper accounts**:
  email+password or magic-link login, **roles** (owner / admin / staff), and
  **per-clinic data isolation** (Supabase Auth + Row-Level Security). This is
  Phase 1 and gates everything else. (PaidUp's `accounts.js` is a reference.)
- **Hosting:** serve the SPA from the same Railway service (or a static host) under
  `app.remireception.com`; API under the same domain.

---

## 6. Phased roadmap

- **Phase 1 — Foundation:** Supabase Auth + RLS, per-clinic accounts + roles,
  `/api` layer, app shell (nav, responsive, PWA manifest), login. _Nothing visible
  yet but everything depends on it._
- **Phase 2 — See everything (read):** Today, Inbox (transcripts), Bookings,
  Get-Paid, Insights. Pure visibility — immediate "wow, I can see what it's doing."
- **Phase 3 — Control everything:** pause/override/snooze/mark-paid/edit-cadence/
  resolve-escalations + the global Pause switch.
- **Phase 4 — Self-serve onboarding in-app:** connect accounting source, payment
  provider, white-label email domain — UI wrapping the endpoints already built.
- **Phase 5 — PWA polish + push:** installable, push notifications (escalations,
  paid invoices, daily brief), offline read.
- **Phase 6 — Operator-OS (future):** staff *talk to* Remi from the dashboard;
  deeper PMS/EHR/accounting actions; "the receptionist becomes a Remi operator."

Native (Capacitor wrap) is an optional Phase 7 only if demand warrants.

---

## 7. Open decisions (for Ashton)
- Auth: Supabase Auth (recommended — integrates with our DB + RLS) vs magic-link
  only vs custom.
- Subdomain: `app.remireception.com` for the dashboard?
- Build order within Phase 2 — lead with Get-Paid (PaidUp) or the front-desk Inbox?
- Keep the current server-rendered `/dashboard` alive during the migration, or
  replace in one cut?
