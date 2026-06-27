# Remi Expansion — "Office Operations" Roadmap

Goal: Remi grows from front-desk (answer + book + get-paid) into the layer that
*runs* the office. The receptionist supervises Remi; Remi does the monotonous
work. Each module below is a slice: data model → brain tools/intents → scheduler
(proactive) → dashboard → tests, then commit.

Foundational concept introduced by Team Ops and reused everywhere: **staff
identity** — Remi recognises when a message is from a *staff member* (matched by
phone) and switches from the client booking brain into a staff brain with its own
tools. Clients still get the booking brain.

---

## 1. Team Ops  *(staff side — flagship)*
Remi runs the staff back-office over WhatsApp.

**Data**
- `staff` — id, clinic_id, name, phone, role (practitioner/admin/owner), pay_rate?, active
- `time_entries` — id, staff_id, clinic_id, clock_in, clock_out, source ('whatsapp'|'dashboard'), note
- `leave_requests` — id, staff_id, clinic_id, start_date, end_date, type (annual/sick/unpaid), reason, status (pending/approved/declined), decided_by, decided_at
- `shifts` — id, staff_id, clinic_id, date, start, end, published  *(roster — slice 2)*

**Staff brain intents** (staffAgent + staffTools)
- clock_in / clock_out (→ time_entries; "you're clocked in at 08:02")
- get_my_hours (this week's total)
- request_leave (→ leave_requests pending; owner notified)
- get_my_schedule (upcoming shifts — slice 2)
- (owner via dashboard/WhatsApp) approve/decline leave, publish roster

**Scheduler / proactive**
- Roster publish + "you're working tomorrow at 9" nudges (slice 2)
- Forgot-to-clock-out guard (auto-flag entries open > N hours)

**Dashboard**
- Team Ops view: live "who's clocked in", timesheets (hours per staff per week,
  payroll-ready export), leave inbox (approve/decline), roster editor (slice 2)

**Slices:** 1a clock in/out + hours + dashboard timesheet · 1b leave requests +
approvals · 2 rosters/shifts + schedule nudges · 3 shift swaps + payroll export

---

## 2. Quick wins
**Tasks & message-taking** — "remind me to call the supplier at 3", "add task:
order gloves", "take a message for Dr X". Table `tasks` (clinic_id, title,
assignee_staff_id?, due_at?, status, source). Brain tools add_task / list_tasks /
complete_task (both client-facing "leave a message for…" and staff-facing). Daily
brief includes open tasks. Dashboard task board.

**Money / end-of-day** — auto receipt to client after payment, daily cash-up
summary to owner (takings by method + count), expense logging by message
("log R450 gloves, supplier X" → `expenses`). Reuses payments + report.

---

## 3. Client OS  *(packages / memberships / CRM)*
- `packages` — client_id, name, sessions_total, sessions_used, expires_at; brain
  decrements on booking, nudges to rebook when low. "How many left?" answered.
- `memberships` — recurring billing for the clinic's own clients (reuse Stripe),
  status, renews_at.
- Richer client profile: notes, preferences, allergies, tags on `clients`.
- Birthday / anniversary touches (scheduler, consent-gated).

---

## 4. Social DMs  *(reach / revenue)*
Remi answers + books from **Instagram DMs + Facebook Messenger** via the Meta
Graph API webhooks → same booking brain → unified inbox. New channel adapter
(`routes/meta.ts`) + per-clinic page/IG connection (`clinics.meta` jsonb with page
token). **Gated on the user completing Meta app setup + app review for
`instagram_manage_messages` / `pages_messaging`.** Build the adapter now; go live
after review.

---

## Cross-cutting
- All staff-facing actions are role-gated; destructive/approval actions need owner.
- Everything conversational flows through the existing conversations/messages
  model (channel noted in meta) so the dashboard inbox stays unified.
- Pure logic (hours math, package decrement, cash-up totals) lives in testable
  helpers, never only in a brain tool.
