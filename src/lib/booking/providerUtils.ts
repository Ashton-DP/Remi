// Small shared helpers for the API-based booking providers (Acuity/Cliniko/Nookal).

/** Thrown when a clinic selected a provider but hasn't supplied the config it needs. */
export class BookingConfigError extends Error {
  constructor(provider: string, what: string) {
    super(`[booking:${provider}] missing config: ${what}`);
    this.name = 'BookingConfigError';
  }
}

/** Require a config value or throw a clear, actionable error. */
export function need<T>(provider: string, what: string, value: T | undefined | null): T {
  if (value === undefined || value === null || value === '') {
    throw new BookingConfigError(provider, what);
  }
  return value;
}

/** Look up a clinic service row (in services_json) by name, case-insensitive. */
export function findService(clinic: any, service?: string): any {
  return (clinic?.services_json ?? []).find(
    (s: any) => String(s.service).toLowerCase() === String(service ?? '').toLowerCase(),
  );
}

/** Split a full name into first / last (last falls back to "-" for APIs that require it). */
export function splitName(name?: string): { firstName: string; lastName: string } {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: 'Guest', lastName: '-' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '-' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/** Base64 for HTTP Basic auth (Node). */
export function basic(user: string, pass = ''): string {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

/** fetch + JSON with a clear error on non-2xx. */
export async function httpJson(provider: string, url: string, init: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[booking:${provider}] ${init.method ?? 'GET'} ${url} → ${res.status} ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}
