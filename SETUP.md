# Remi — Slice 0 setup (WhatsApp sandbox)

Goal: message Remi on the Twilio WhatsApp **sandbox** and have her answer, check
availability, and book a (test) appointment.

## 1. Install
```bash
npm install
cp .env.example .env
```

## 2. Supabase
1. Create a Supabase project → copy the **Project URL** and **service_role key** into `.env`.
2. SQL editor → run `db/schema.sql`, then `db/seed.sql`.
3. Copy the clinic `id` returned by the seed into `DEFAULT_CLINIC_ID` in `.env`.

## 3. AI provider (Gemini or Claude)
Set `AI_PROVIDER` in `.env`:
- **`gemini`** (default, free) — get a key at https://aistudio.google.com/apikey,
  put it in `GEMINI_API_KEY`. Model defaults to `gemini-2.5-flash`.
- **`claude`** — put your `ANTHROPIC_API_KEY` in `.env`; model defaults to `claude-opus-4-8`
  (switch to `claude-sonnet-4-6` / `claude-haiku-4-5` to cut cost).

> ⚠️ **POPIA / data privacy:** Google's *free* Gemini tier may use prompts to improve
> their models. That's fine for testing with fake data, but **before any real patient
> conversation**, switch to a paid tier (Gemini paid or Claude) where prompts are not
> used for training. It's a one-line change to `AI_PROVIDER` / the key.

## 4. Google Calendar (optional for first test)
If `GOOGLE_SERVICE_ACCOUNT_JSON` is empty, Remi runs in **demo mode** — every slot
is treated as open and bookings get a placeholder event id (still written to Supabase).
To wire a real calendar:
1. Create a Google Cloud service account, enable the Calendar API, download the JSON key.
2. Share the target calendar with the service-account email.
3. Set `GOOGLE_CALENDAR_ID` and base64 the key into `GOOGLE_SERVICE_ACCOUNT_JSON`:
   `base64 -i key.json | tr -d '\n'`

## Test locally first (fastest — no Twilio, no tunnel)
Once `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`), `SUPABASE_SERVICE_KEY`, and
`DEFAULT_CLINIC_ID` are set, talk to Remi straight from your terminal:
```bash
npm run chat
```
This runs the exact same brain + Supabase + booking path as WhatsApp. Try:
*"Hi, do you have space for Botox this week?"* → it should greet you, offer slots,
confirm, and write a row to `bookings` / `events`. Steps 5–7 below are only needed
to put it on real WhatsApp.

## 5. Twilio WhatsApp sandbox
1. Twilio console → Messaging → Try it out → **WhatsApp sandbox**.
2. From your phone, send the join code to the sandbox number to opt in.
3. Put `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` in `.env` (sandbox `From` is already the default).

## 6. Run + expose
```bash
npm run dev
```
Expose `http://localhost:3000` with a tunnel (e.g. `ngrok http 3000` or `cloudflared`),
then set the sandbox **"When a message comes in"** webhook to:
`https://<your-tunnel>/webhooks/whatsapp`  (HTTP POST)

## 7. Test
Message the sandbox number: *"Hi, do you have space for Botox this week?"*
Remi should greet you, offer slots, confirm, and book. Check the `bookings`,
`messages`, and `events` tables in Supabase to confirm.

## Notes / TODO (next slices)
- Real WhatsApp Business sender approval (start early — it gates the pilot).
- Twilio request-signature validation on the webhook.
- Reminders + waitlist backfill + the "R recovered" report (Slice 2).
- Move from synchronous TwiML reply to async send for slow/multi-tool turns.
