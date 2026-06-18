# WhatsApp Business API — Message Templates

On the WhatsApp **Business API** (production, not the sandbox), any message Remi
*initiates* — i.e. sent outside the 24-hour window after the customer's last
message — **must use a pre-approved template**. Free-form proactive sends are
rejected. (Replies *within* the 24h customer-service window can stay free-form,
so the live booking conversation itself needs no template.)

Twilio is the BSP, so create these in **Twilio Console → Messaging → Content
Template Builder** (or via the Content API). Twilio submits them to Meta for
approval (usually a few hours to ~2 days). Each approved template returns a
**Content SID** (`HX...`) — record it in the table at the bottom; the code will
send by SID + variables instead of raw text.

Notes for every template below:
- **Category: UTILITY** (transactional — reminders/confirmations). Utility
  templates approve faster and cost less than MARKETING.
- **Language: `en`** (use `en`, not `en_ZA` — South-African English isn't a
  separate WhatsApp locale).
- Variables are positional: `{{1}}`, `{{2}}`, … Provide the sample values shown
  so the reviewer can see a realistic message.
- Names must be lowercase with underscores.

---

## 1. `appointment_reminder_48h`
**Category:** UTILITY · **Language:** en
**Body:**
```
Hi {{1}} 👋 Friendly reminder: you have {{2}} booked for {{3}}. Reply CONFIRM to lock it in or CANCEL if your plans changed.
```
**Variables:** {{1}} client name · {{2}} service · {{3}} date/time
**Sample:** {{1}}=Sarah · {{2}}=a Botox consultation · {{3}}=Thu 20 Jun, 09:00

---

## 2. `appointment_reminder_24h`
**Category:** UTILITY · **Language:** en
**Body:**
```
Your {{1}} is tomorrow at {{2}}. Reply CONFIRM to confirm or RESCHEDULE if you need a different time.
```
**Variables:** {{1}} service · {{2}} date/time
**Sample:** {{1}}=Botox consultation · {{2}}=09:00, Thu 20 Jun

---

## 3. `appointment_reminder_2h`
**Category:** UTILITY · **Language:** en
**Body:**
```
See you soon! Your {{1}} starts in about 2 hours ({{2}}). We can't wait 😊
```
**Variables:** {{1}} service · {{2}} date/time
**Sample:** {{1}}=Botox consultation · {{2}}=09:00 today

---

## 4. `waitlist_slot_offer`
**Category:** UTILITY · **Language:** en
**Body:**
```
Hi {{1}}! A slot just opened for {{2}} on {{3}}. Would you like to book it? Reply YES and we'll confirm it for you.
```
**Variables:** {{1}} client name · {{2}} service · {{3}} date/time
**Sample:** {{1}}=Sarah · {{2}}=a chemical peel · {{3}}=Fri 21 Jun, 14:00

---

## 5. `missed_call_text_back`
**Category:** UTILITY · **Language:** en
**Body:**
```
Hi {{1}} 👋 You just called {{2}} but we missed you. I'm Remi, the virtual assistant — I can help you book an appointment or answer any questions right here on WhatsApp. What can I help you with?
```
**Variables:** {{1}} client name · {{2}} clinic name
**Sample:** {{1}}=Sarah · {{2}}=Demo Aesthetics
> Note: original code didn't personalise the name; added {{1}} so the template
> reads naturally. If the caller is unknown, pass "there".

---

## Approved Content SIDs (fill in after Twilio approval)

| Template | Content SID | Status |
|---|---|---|
| appointment_reminder_48h | `HX…` | ⬜ pending |
| appointment_reminder_24h | `HX…` | ⬜ pending |
| appointment_reminder_2h  | `HX…` | ⬜ pending |
| waitlist_slot_offer      | `HX…` | ⬜ pending |
| missed_call_text_back    | `HX…` | ⬜ pending |

Once these have SIDs, update `lib/twilio.ts` to send via
`contentSid` + `contentVariables` for proactive messages (scheduler reminders,
waitlist offer, missed-call text-back), keeping free-form `body` only for
in-window replies.
