# ElevenLabs Agent — Server Tools setup

Wire the voice agent to Remi's real booking system. In the ElevenLabs agent, go to
**Tools → Add tool → Webhook (server tool)** and create each tool below.

**Base URL:** `https://www.remireception.com/tools/<tool>` · **Method:** `POST`

**Security (recommended):** set `TOOLS_SHARED_SECRET=<a long random string>` on Render,
then on every tool below add a request **header** `X-Tool-Secret: <same string>`.
Without it the endpoints are open to anyone who finds them.

**Caller identity:** for phone calls, set the `caller_phone` parameter's value to the
ElevenLabs system dynamic variable for the caller's number (e.g. `{{system__caller_id}}`).
On the web widget there's no caller id — it falls back to a demo client.

**Dates:** the agent must send `date` as `YYYY-MM-DD` and `start_at` as a full ISO
datetime returned by `check_availability` (e.g. `2026-06-20T09:00:00+02:00`). Add the
current date to the agent so it can resolve "tomorrow/Tuesday" — e.g. include
"Today is {{system__time}}" in the system prompt.

---

### 1. check_availability
- **URL:** `/tools/check_availability` · **Description:** "Get open appointment times for a service on a date. Call this when the caller names a day."
- **Body params:**
  - `date` (string, required) — `YYYY-MM-DD`
  - `service` (string, required) — the treatment name
- **Returns:** `available_slots` (array of ISO datetimes) → offer 2-3 of these to the caller.

### 2. create_booking
- **URL:** `/tools/create_booking` · **Description:** "Book the appointment. Call only after the caller confirms a specific time."
- **Body params:**
  - `service` (string, required)
  - `start_at` (string, required) — one of the ISO slots from check_availability
  - `client_name` (string, required)
  - `caller_phone` (string) — set to `{{system__caller_id}}`
- **Returns:** `{ ok, booking_id, when }`.

### 3. reschedule_booking
- **URL:** `/tools/reschedule_booking` · **Description:** "Move the caller's upcoming appointment to a new time (call check_availability first)."
- **Body params:**
  - `new_start_at` (string, required) — ISO slot
  - `caller_phone` (string) — `{{system__caller_id}}`

### 4. cancel_booking
- **URL:** `/tools/cancel_booking` · **Description:** "Cancel the caller's upcoming appointment. Frees the slot and offers it to the waitlist."
- **Body params:**
  - `caller_phone` (string) — `{{system__caller_id}}`

### 5. add_to_waitlist
- **URL:** `/tools/add_to_waitlist` · **Description:** "Add the caller to the waitlist when no slots are available; they're texted when one opens."
- **Body params:**
  - `service` (string, required)
  - `preferred_window` (string, optional) — e.g. "weekday mornings"
  - `caller_phone` (string) — `{{system__caller_id}}`

### 6. get_services (optional)
- **URL:** `/tools/get_services` · **Description:** "List the clinic's treatments and prices." No params. (Usually unnecessary — prices are already in the prompt.)

---

Every booking made through these tools writes to Supabase, so it shows in the
dashboard, triggers the 48h/24h/2h reminders, and counts in the "R recovered" report —
exactly like a WhatsApp booking.
