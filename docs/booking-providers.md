# Booking providers

Remi connects to whatever booking system a clinic uses, through one interface
(`src/lib/booking/types.ts` → `BookingProvider`). The booking flow (slot finding +
create / reschedule / cancel) only talks to that interface, so adding a system is
a single new file + one line in `src/lib/booking/index.ts`.

Pick a clinic's system with `clinics.booking_provider`. Unknown or not-yet-built
values fall back to **Google Calendar** so booking always works.

| Provider | Status | Notes |
|---|---|---|
| `google` | ✅ tested path | Universal default. Works for any clinic with no API of its own; Remi's calendar is the source of truth. Per-clinic calendar via `google_calendar_id`. |
| `acuity` | 🟡 built, **untested on a live account** | Cleanest fit — create takes client details inline (no patient pre-lookup). |
| `cliniko` | 🟡 built, **untested on a live account** | Includes a find-or-create patient step that must be verified. |
| `nookal` | 🟡 built, **untested on a live account** | Availability response parsing + patient create need verification. |
| `fresha` | ⛔ no public booking API | Use a Google-Calendar mirror of their diary (run on `google`). |
| `goodx` | ⬜ partner/contract integration | Not built. |

> 🟡 The Acuity/Cliniko/Nookal adapters are written against each vendor's published
> API (verified June 2026) but **have not been run against a live account**. Before
> a clinic goes live on one, do an end-to-end test (availability → book → reschedule
> → cancel) with real credentials and fix any field/shape mismatches.

## Config

Run `db/migrate_booking_provider.sql`, then `notify pgrst, 'reload schema';`.

Credentials are **per-clinic** (on the `clinics` row). The mapping from a clinic
**service** to the provider's appointment type is **per-service**, stored inside the
existing `services_json` entries (each entry already has `service`, `duration_min`,
`price_zar` — just add the provider id field).

### Acuity
- Clinic: `acuity_user_id`, `acuity_api_key`, `acuity_calendar_id` (optional default)
- Per service in `services_json`: `acuity_type_id` (required), `acuity_calendar_id` (optional)

### Cliniko
- Clinic: `cliniko_api_key` (includes shard suffix, e.g. `…-au1`), `cliniko_business_id`, `cliniko_practitioner_id` (default)
- Per service: `cliniko_appointment_type_id` (required), `cliniko_practitioner_id` (optional override)

### Nookal
- Clinic: `nookal_api_key`, `nookal_location_id`, `nookal_practitioner_id` (default)
- Per service: `nookal_appointment_type_id` (required)

Example `services_json` entry for a Cliniko clinic:
```json
{ "service": "Botox consultation", "duration_min": 30, "price_zar": 800,
  "cliniko_appointment_type_id": "123456" }
```

If a clinic selects a provider but omits required config, the adapter throws a
clear `BookingConfigError` naming exactly what's missing (rather than silently
booking into the wrong place).

## Adding a new provider
1. Create `src/lib/booking/<name>Provider.ts` implementing `BookingProvider`.
   Implement `getAvailableSlots` if the API returns open slots directly, or
   `getBusy` if it returns busy windows (like Google).
2. Register it in `src/lib/booking/index.ts` (`PROVIDERS`), and drop it from
   `PLANNED` if it was listed there.
3. Add any credential columns to `db/migrate_booking_provider.sql` and document
   the per-service mapping here.
4. Add tests to `tests/booking.test.ts`.
