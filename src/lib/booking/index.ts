import type { BookingProvider } from './types';
import { googleProvider } from './googleProvider';
import { acuityProvider } from './acuityProvider';
import { clinikoProvider } from './clinikoProvider';
import { nookalProvider } from './nookalProvider';

export type { BookingProvider, BookingEventInput, BusyWindow } from './types';

/**
 * Registry of implemented booking providers, keyed by `clinic.booking_provider`.
 *
 * To add a clinic's booking system (Fresha, Acuity, Nookal, Cliniko, GoodX, …):
 *   1. create `src/lib/booking/<name>Provider.ts` implementing `BookingProvider`
 *   2. add one line here
 * Nothing else in the app changes — slot finding and the create/reschedule/cancel
 * tools all go through `getBookingProvider(clinic)`.
 */
const PROVIDERS: Record<string, BookingProvider> = {
  google: googleProvider,
  acuity: acuityProvider,
  cliniko: clinikoProvider,
  nookal: nookalProvider,
};

/** Register a booking provider at runtime (e.g. a new integration at startup). */
export function registerBookingProvider(provider: BookingProvider): void {
  PROVIDERS[provider.name.toLowerCase()] = provider;
}

/** Providers we intend to support but haven't built yet (for clear logging).
 *  Fresha has no usable public booking API → use a Google-Calendar mirror.
 *  GoodX requires a partner/contract integration. */
const PLANNED = new Set(['fresha', 'goodx']);

/**
 * Resolve the booking provider for a clinic. Defaults to Google Calendar (the
 * universal fallback) when the clinic has no `booking_provider` set, or when the
 * requested one isn't implemented yet — so booking always works rather than
 * erroring on a misconfigured clinic.
 */
export function getBookingProvider(clinic: any): BookingProvider {
  const requested = String(clinic?.booking_provider ?? 'google').toLowerCase();
  const provider = PROVIDERS[requested];
  if (provider) return provider;

  if (PLANNED.has(requested)) {
    console.warn(
      `[booking] provider "${requested}" not implemented yet — falling back to Google Calendar for clinic ${clinic?.id ?? '?'}`,
    );
  } else if (requested !== 'google') {
    console.warn(
      `[booking] unknown provider "${requested}" — falling back to Google Calendar for clinic ${clinic?.id ?? '?'}`,
    );
  }
  return googleProvider;
}
