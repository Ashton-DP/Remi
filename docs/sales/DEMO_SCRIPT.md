# Remi — Demo Dry-Run

How to run a sharp, 5-minute demo that makes a clinic owner *feel* the missed-
booking problem and see Remi solve it live.

---

## Setup (once, before demos)

1. **Seed the sandbox clinic** (idempotent):
   ```
   node --env-file=.env scripts/seedDemoClinic.mjs
   ```
   It prints the clinic id + dashboard link. Set `DEFAULT_CLINIC_ID=<that id>` in
   `.env`/Railway if you want the voice widget pointed at it.
2. **Open two tabs ready to share:**
   - The landing page **www.remireception.com** (has the live "Talk to Remi" voice widget)
   - The dashboard: `www.remireception.com/dashboard/<demo-clinic-id>?token=<DASHBOARD_TOKEN>`
3. Have your phone ready to WhatsApp the demo number.

---

## The 5-minute demo flow

**1. Frame the problem (30s).** "Before I show you anything — how many calls do you
reckon you miss in a busy week? … Right. Each of those is R300+ walking to the next
clinic. Here's what catching them looks like."

**2. Talk to Remi live (90s).** On the landing page, click **"Talk to Remi"** and
let *them* speak to it: "Ask it to book a Botox consultation for Thursday." Let them
hear it answer naturally, offer times, and confirm. This is the wow moment — they
hear a real receptionist that never sleeps.

**3. Show the booking land (60s).** Switch to the dashboard — show the booking that
just appeared, the caller, the status. "That would've been a missed call at 7pm.
Instead it's in your diary."

**4. Show the recovery angle (60s).** Explain the missed-call → WhatsApp text-back
and the waitlist backfill: "If someone cancels, Remi offers the slot to the next
person automatically — that empty slot fills itself."

**5. The close (60s).** "I'll set this up on *your* number, free, for two weeks,
alongside your front desk. Then I show you the bookings it caught. Like the number →
R[tier]/mo. If not → we switch it off." Then capture: booking number + which
booking system they use.

---

## What to have answers ready for
- **"How natural is the voice?"** → they just heard it; tune per clinic.
- **"Does it work with Fresha?"** → yes, runs alongside; Remi answers what Fresha can't.
- **"Patient data?"** → POPIA-conscious, EU-hosted, operator agreement provided.
- **"Setup effort?"** → done-for-you; 10 min of clinic info from you.

## After the demo
- Send the **one-pager** (`docs/sales/ONE_PAGER`) + their **trial link**
  (`scripts/createClinicSubscriptionLink.mjs <tier> <clinic_id>`).
- Log them in the target list (`docs/sales/OUTREACH`).
- Two weeks later: show the recovered-bookings number → convert.

---

### Demo hygiene
- Reset the sandbox anytime by re-running the seed (idempotent).
- Don't demo on a real clinic's data — always use the sandbox clinic.
- If the voice widget is slow on first load, click it once before the call to warm it.
