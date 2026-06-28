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

## 6. `aftercare_check_in`
**Category:** UTILITY · **Language:** en
**Body:**
```
Hi {{1}} 💛 Hope your {{2}} went well today! If you have any questions or anything doesn't feel right, just reply here — we're happy to help.
```
**Variables:** {{1}} client name · {{2}} service
**Sample:** {{1}}=Sarah · {{2}}=chemical peel
> Sent ~3h after the appointment (Premium). Wired to `WA_TEMPLATE_AFTERCARE`.

---

## 7. `review_request`
**Category:** UTILITY (Meta may reclassify as MARKETING — submit as UTILITY first) · **Language:** en
**Body:**
```
Hi {{1}} 🌟 Thanks so much for visiting {{2}}! If you have a moment, a quick Google review really helps us: {{3}}
```
**Variables:** {{1}} client name · {{2}} clinic name · {{3}} review URL
**Sample:** {{1}}=Sarah · {{2}}=Demo Aesthetics · {{3}}=https://g.page/r/example/review
> Sent ~24h after the appointment, only if `clinics.google_review_url` is set.
> Wired to `WA_TEMPLATE_REVIEW`. The URL is a positional variable — if Meta
> rejects a variable URL, switch the link to a static **button** in the builder.

---

## 8. `reactivation_winback`
**Category:** MARKETING (consent-gated) · **Language:** en
**Body:**
```
Hi {{1}} 👋 It's been a while since your last visit to {{2}}. We'd love to see you again — just reply here and I'll find a time that suits you.
```
**Variables:** {{1}} client name · {{2}} clinic name
**Sample:** {{1}}=Sarah · {{2}}=Demo Aesthetics
> ⚠️ This is **marketing**, not a service message. Needs (a) Meta MARKETING
> category approval and (b) prior POPIA consent — the code already gates sends on
> `clients.consent_at` / `last_reactivated_at`. Wired to `WA_TEMPLATE_REACTIVATION`.

---

## 9. `deposit_request`
**Category:** UTILITY · **Language:** en
**Body:**
```
To secure your {{1}} on {{2}}, please pay your R{{3}} deposit here: {{4}}
```
**Variables:** {{1}} service · {{2}} date/time · {{3}} deposit amount (ZAR) · {{4}} payment link
**Sample:** {{1}}=a Botox consultation · {{2}}=Thu 20 Jun, 09:00 · {{3}}=200 · {{4}}=https://pay.yoco.com/example
> Sent on booking when the clinic has `deposit_zar` + `deposit_link` configured.
> Wired to `WA_TEMPLATE_DEPOSIT`. Same variable-URL caveat as #7.

> **Not templated (by design):** the **daily owner summary** (sent to the owner's
> own number) is a long, fully-dynamic report and isn't a patient message. In
> production, either have the owner message Remi first each day (stays in the 24h
> window) or build a short structured summary template later. Tracked, not blocking.

---

## Approved Content SIDs (fill in after Twilio approval)

The code is **already wired** (`lib/twilio.ts` → `sendProactiveWhatsApp`): when the
matching env var below holds a Content SID, that proactive message is sent as the
approved template; when blank, it falls back to free-form text (sandbox / 24h
window). So going live is just **pasting the approved SIDs into env** — no code change.

Status last checked **2026-06-27** via the Twilio Content API
(`GET /v1/Content/{sid}/ApprovalRequests`). None are approved yet: all 9 are pending
Meta review. (Two earlier ones, `review_request` / `deposit_request`, were rejected
for ending on a variable — Meta error 2388299 — and reworded + resubmitted as `*_v2`.)
Re-check anytime with `npm run check:templates`.

### Categories & opt-outs (important)

Meta classifies each template as **UTILITY** (transactional — cheaper, exempt from
marketing opt-out) or **MARKETING** (promotional — pricier, must honour opt-outs):

| Category | Templates |
|---|---|
| **UTILITY** | appointment_reminder 48h/24h/2h · aftercare_check_in · deposit_request_v2 |
| **MARKETING** | review_request_v2 · reactivation_winback · waitlist_slot_offer · missed_call_text_back |

Meta auto-recategorises borderline ones (e.g. it moved `review_request_v2`
UTILITY→MARKETING) — that's expected; it doesn't block approval.

**Opt-out handling (code):** MARKETING sends go through `sendMarketingWhatsApp`
(`lib/twilio.ts`), which skips any contact on the `suppressions` opt-out list.
A customer replying **STOP** is added to the list (both whatsapp + sms channels);
**START** removes them (`routes/whatsapp.ts`). UTILITY/transactional sends
(reminders, deposits) use `sendProactiveWhatsApp` directly and are **not** suppressed,
since they're service messages for a booking the customer made. Note: `consent_at`
is auto-stamped at first contact, so it's an implied-consent record, not a marketing
opt-in — the suppression list is the real opt-out gate.

| Template | Env var to set | Content SID | Status |
|---|---|---|---|
| appointment_reminder_48h | `WA_TEMPLATE_REMINDER_48H`  | `HX43001f0a31c1c9863db65c55df4ae5bb` | 🟡 pending (Meta review) |
| appointment_reminder_24h | `WA_TEMPLATE_REMINDER_24H`  | `HXf6f911684827eaa8e920f5ac63f2b66f` | 🟡 pending (Meta review) |
| appointment_reminder_2h  | `WA_TEMPLATE_REMINDER_2H`   | `HXdbf60657a72f12f04f12052fe08369e3` | 🟡 pending (Meta review) |
| waitlist_slot_offer      | `WA_TEMPLATE_WAITLIST_OFFER`| `HX9469a351b614c835750270cefd00b969` | 🟡 pending (Meta review) |
| missed_call_text_back    | `WA_TEMPLATE_MISSED_CALL`   | `HX52c52583073f84c30254060f458674ec` | 🟡 pending (Meta review) |
| aftercare_check_in       | `WA_TEMPLATE_AFTERCARE`     | `HXf3422c2e2edeff72f932fd0b7568a02d` | 🟡 pending (Meta review) |
| reactivation_winback     | `WA_TEMPLATE_REACTIVATION`  | `HX993c49331463e7946049cd5b2e35c56c` | 🟡 pending (Meta review) |
| ~~review_request~~       | —                           | ~~`HX717758e35b53edee962e0676cbfa0fd8`~~ | 🔴 rejected (var at end) → replaced |
| review_request_v2        | `WA_TEMPLATE_REVIEW`        | `HX5c26c95050812859b02b44be0a363ed8` | 🟡 resubmitted (Meta review) |
| ~~deposit_request~~      | —                           | ~~`HX7b05b5f0968d53782a94da142ecb6234`~~ | 🔴 rejected (var at end) → replaced |
| deposit_request_v2       | `WA_TEMPLATE_DEPOSIT`       | `HX1ef2062e9bccaece480d32711ebe075c` | 🟡 resubmitted (Meta review) |

Reworded bodies for the two resubmitted templates (moved the trailing variable so
no `{{n}}` sits at the start or end):
- **review_request_v2:** `Hi {{1}} 🌟 Thanks so much for visiting {{2}}! A quick Google review at {{3}} would really help us. Thank you!`
- **deposit_request_v2:** `To secure your {{1}} on {{2}}, pay your R{{3}} deposit at {{4}} — your slot is held until payment is received.`

After Meta approves each template in Twilio, copy its Content SID into the env var
(locally in `.env` and in Railway's Variables), redeploy, and proactive sends
switch to templates automatically. Until then, proactive messages fall back to
free-form text (only deliverable inside the 24h window) — use the SMS fallback
(`MESSAGING_CHANNEL=sms`) for reliable proactive sends at launch.

To re-check status anytime: `GET https://content.twilio.com/v1/Content/{sid}/ApprovalRequests`
(basic auth with the Twilio SID/token).
