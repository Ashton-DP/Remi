# Remi — MVP Build Spec

> Companion to [ADR-0001](adr/0001-whatsapp-first-mvp-architecture.md). This spec is the
> buildable detail for the WhatsApp MVP: the conversation brain, the data model, and the
> tools Claude can call. Scope = Slices 0–2 (WhatsApp booking, missed-call recovery,
> no-shows + backfill + report). Voice and deep calendar sync are out of scope here.

---

## 1. System overview

```
                     ┌──────────────┐
 WhatsApp / Call ───▶│    Twilio    │
                     └──────┬───────┘
                            │ webhook (inbound msg / missed call)
                            ▼
                     ┌──────────────┐      tool calls       ┌──────────────┐
                     │  Remi server │◀────────────────────▶│    Claude    │
                     │ (orchestrator)│   (booking brain)    └──────────────┘
                     └──┬───────┬───┘
            read/write  │       │  create/read events
                        ▼       ▼
                  ┌──────────┐  ┌──────────────┐
                  │ Supabase │  │   Calendar   │
                  │  (data)  │  │ (Google/Cal) │
                  └──────────┘  └──────────────┘
                        ▲
                        │ cron (every ~5 min)
                  ┌──────────────┐
                  │  Scheduler   │  reminders, no-show checks, waitlist offers
                  └──────────────┘
```

**Three entry points:**
1. **Inbound WhatsApp** → webhook → orchestrator → Claude → reply.
2. **Missed/unanswered call** → Twilio voice webhook → orchestrator fires a WhatsApp follow-up.
3. **Scheduler (cron)** → sends reminders, detects at-risk no-shows, offers freed slots to the waitlist.

**Stack (recommended for build):**
- **Runtime:** Node + TypeScript (best SDK support for Twilio, Supabase, Anthropic; matches existing web work).
- **Hosting:** a small always-on server (Render / Fly / Railway) *or* Supabase Edge Functions for the webhook + a scheduled function for the cron. Pick one in build; both work.
- **Model:** `claude-sonnet-4-6` as the booking brain (quality + cost balance for live chat). `claude-haiku-4-5-20251001` as a cost lever for high-volume simple turns once tuned. Use Anthropic tool-use.
- This runtime/hosting choice can be promoted to **ADR-0002** if we want it formally ratified.

---

## 2. Conversation design

### 2.1 Persona
Remi speaks **as the clinic** ("Hi, this is Remi from {{clinic_name}}"). Tone: warm,
brief, helpful, professional. Never robotic, never pushy. Mirrors the client's language
(English/Afrikaans where obvious). Per-clinic tone notes can adjust voice.

### 2.2 Intents Remi handles
- **Book** an appointment (primary)
- **Reschedule / cancel** an existing booking
- **Pricing / FAQ** (hours, location, parking, treatment questions — answered from clinic data only)
- **Confirm** (reply to a reminder)
- **Human handoff** (anything sensitive/complex/angry/clinical)
- **Opt-out** (STOP)

### 2.3 Happy-path booking flow
1. Greet + (first contact only) consent line.
2. Identify intent + treatment of interest.
3. Ask preferred day/time window. `check_availability`.
4. Offer 2–3 concrete slots. If none fit → offer alternatives or `add_to_waitlist`.
5. Collect name (phone comes from WhatsApp). `create_booking`.
6. Confirm in writing + what to expect. `log_event(booking_created)`.

### 2.4 Hard guardrails (in system prompt)
- **Never invent** availability, prices, or policies — only use tool results / clinic data.
- **Never give medical advice or diagnose.** Treatment-suitability questions → "the practitioner will confirm at consultation" or `escalate_to_human`.
- **Always confirm** date, time, treatment, and name back before calling `create_booking`.
- If unsure or out of scope → `escalate_to_human`, don't guess.
- One booking action per confirmed request; no double-booking.

### 2.5 Sample copy (clinic-editable)
- **Greeting + consent (first message):**
  *"Hi! This is Remi from {{clinic_name}} 💬 I can help you book or answer a quick question. By replying you're happy for us to message you about your booking. How can I help?"*
- **Offer slots:** *"Lovely — for {{service}} I've got Tue 14:00, Wed 10:30, or Thu 16:00. Which suits?"*
- **No availability:** *"We're fully booked that week. Want me to pop you on the waitlist and message you the moment a slot opens?"*
- **Confirmation:** *"You're booked ✅ {{service}} on {{date}} at {{time}}. We'll send a reminder beforehand. Reply CHANGE to move it."*
- **After-hours:** *"Thanks for messaging! The clinic's closed now, but I can book you in right away — what day works?"* (Remi works regardless of hours.)
- **Opt-out:** any message containing **STOP** → confirm opt-out, set `consent=false`, stop proactive messages.

### 2.6 WhatsApp platform rules (important)
- **24-hour session window:** Remi can reply freely within 24h of the client's last message. **Outside** that window, proactive messages (reminders, missed-call follow-ups, waitlist offers) **must use a pre-approved WhatsApp template**. Build template variants for: missed-call follow-up, appointment reminder, waitlist-slot offer.
- **Sandbox** for build/test (testers opt in with a code); **approved business sender** for the pilot.

---

## 3. Tools (Claude function definitions)

| Tool | Inputs | Returns | Side effect |
|---|---|---|---|
| `lookup_client` | `phone` | client record or null | — |
| `get_services` | — | list of `{service, price_zar, duration_min}` | — |
| `check_availability` | `service`, `date_from`, `date_to` | array of open slots | — |
| `create_booking` | `client_name`, `phone`, `service`, `start_at` | `booking_id`, confirmation | writes booking + calendar event + `booking_created` event |
| `reschedule_booking` | `booking_id`, `new_start_at` | updated booking | updates booking + calendar |
| `cancel_booking` | `booking_id`, `reason?` | ok | updates booking; triggers waitlist backfill |
| `add_to_waitlist` | `client_name`, `phone`, `service`, `preferred_window` | `waitlist_id` | writes waitlist row |
| `escalate_to_human` | `reason`, `summary` | ok | notifies clinic contact; flags conversation |
| `log_consent` | `phone`, `consent:boolean` | ok | sets `clients.consent_at` |

Tool results are returned to Claude; Claude composes the natural-language reply. The
**orchestrator owns all side effects** — Claude never writes data directly.

---

## 4. Data model (Supabase / Postgres)

```sql
-- A clinic = one tenant
clinics (
  id uuid pk, name text, whatsapp_number text, timezone text default 'Africa/Johannesburg',
  hours_json jsonb,            -- opening hours
  calendar_ref text,           -- google cal id / cal.com link
  services_json jsonb,         -- [{service, price_zar, duration_min}]
  faq_json jsonb,              -- canned answers
  tone_notes text,
  escalation_contact text,     -- owner phone for handoffs
  avg_new_client_value_zar int,-- for the recovered-revenue report
  created_at timestamptz default now()
)

clients (
  id uuid pk, clinic_id uuid fk, name text, phone text,
  consent_at timestamptz, notes text, created_at timestamptz default now(),
  unique (clinic_id, phone)
)

conversations (
  id uuid pk, clinic_id uuid fk, client_id uuid fk,
  channel text,                -- 'whatsapp' | 'missed_call'
  status text,                 -- 'open' | 'booked' | 'escalated' | 'closed'
  last_message_at timestamptz, created_at timestamptz default now()
)

messages (
  id uuid pk, conversation_id uuid fk,
  direction text,              -- 'in' | 'out'
  body text, meta jsonb, created_at timestamptz default now()
)

bookings (
  id uuid pk, clinic_id uuid fk, client_id uuid fk,
  service text, start_at timestamptz, end_at timestamptz,
  status text,                 -- 'pending'|'confirmed'|'cancelled'|'no_show'|'completed'
  source text,                 -- 'whatsapp'|'missed_call'|'manual'
  after_hours boolean,         -- true if booked outside staffed hours (for attribution)
  calendar_event_id text, created_at timestamptz default now()
)

waitlist (
  id uuid pk, clinic_id uuid fk, client_id uuid fk, service text,
  preferred_window text, status text,  -- 'waiting'|'offered'|'filled'|'expired'
  created_at timestamptz default now()
)

reminders (
  id uuid pk, booking_id uuid fk,
  kind text,                   -- 'confirm'|'48h'|'24h'|'2h'
  scheduled_for timestamptz, sent_at timestamptz,
  status text, response text   -- 'pending'|'sent'|'confirmed'|'reschedule'|'no_response'
)

events (                        -- powers the "R recovered" report
  id uuid pk, clinic_id uuid fk, booking_id uuid fk,
  type text,                   -- 'enquiry_received'|'missed_call_recovered'|
                               -- 'booking_created'|'slot_backfilled'|'no_show_prevented'
  value_zar int, created_at timestamptz default now()
)

escalations (
  id uuid pk, conversation_id uuid fk, reason text, summary text,
  status text, created_at timestamptz default now()
)
```

**POPIA:** store only what's needed (name + phone + booking). `consent_at` set on first
reply. STOP clears it. Define a retention period and a per-clinic operator agreement before
go-live.

---

## 5. Core flows (pseudocode)

### 5.1 Inbound WhatsApp
```
on inbound_message(from, body):
  client  = lookup_or_create_client(from)
  convo   = open_or_get_conversation(client)
  save_message(convo, 'in', body)
  if first_contact: ensure consent line is shown; log_event(enquiry_received)
  history = last N messages
  reply   = claude(system_prompt(clinic), history, tools)   # may call tools
  apply_side_effects(reply.tool_calls)                        # orchestrator does the writes
  send_whatsapp(from, reply.text)
  save_message(convo, 'out', reply.text)
```

### 5.2 Missed / unanswered call
```
on call_status(no-answer | busy | after-hours):
  log_event(missed_call_recovered candidate)
  send_whatsapp_template(caller, 'missed_call_followup')   # template (likely outside 24h window)
  # conversation then proceeds as 5.1 when they reply
```

### 5.3 Scheduler (cron ~5 min)
```
# reminders
for booking in upcoming where reminder due and not sent:
   send reminder (template if outside 24h window); mark sent

# at-risk no-shows
for booking 2h away and not confirmed:
   send final nudge; if still silent -> flag (optional escalate)

# waitlist backfill
on cancellation:
   slot = freed slot
   next = first waiting waitlist entry matching service/window
   offer slot to next (template); on accept -> create_booking + log_event(slot_backfilled)
```

### 5.4 "R recovered" attribution (be conservative — this is the trust/sales artifact)
Count **hard rand** only where Remi clearly added it:
- `missed_call_recovered` → booking that came from an after-hours/unanswered contact = service price (or `avg_new_client_value_zar`).
- `slot_backfilled` → a cancellation Remi refilled = service price.
- `no_show_prevented` → tracked as a **count**, shown separately (don't inflate the rand figure).
Monthly report = sum of hard rand + supporting counts (enquiries answered, bookings made,
slots backfilled, no-shows prevented).

---

## 6. Slice mapping

- **Slice 0 (demoable):** §2 conversation + §3 tools `get_services`/`check_availability`/`create_booking` + §4 core tables + §5.1, on the **sandbox**. Shallow calendar.
- **Slice 1:** edge cases, `escalate_to_human`, guardrail hardening, §5.2 missed-call→WhatsApp.
- **Slice 2:** §5.3 reminders + waitlist backfill + §5.4 report. Then real sender → pilot.

---

## 7. Open questions / TODO
- Pilot calendar: Google Calendar vs Cal.com (affects `check_availability`/`create_booking` impl).
- Build the 3 WhatsApp templates (missed-call, reminder, waitlist) for approval early.
- Confirm `avg_new_client_value_zar` per clinic during discovery.
- POPIA: retention period + operator agreement template.
- Hosting decision (server vs Supabase Edge Functions) → maybe ADR-0002.
