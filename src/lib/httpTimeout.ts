/**
 * Installs a default timeout on the global `fetch`, so a hung external API (a
 * payment provider, Supabase, an invoice source, Resend, etc.) can never block a
 * request handler or — worse — freeze the scheduler's serial tick indefinitely
 * and silently halt all reminders.
 *
 * Calls that pass their own AbortSignal (e.g. the voice barge-in stream) are left
 * untouched, since they manage their own lifecycle.
 */
let installed = false;

export function installFetchTimeout(ms = 30_000): void {
  if (installed) return;
  const original = globalThis.fetch;
  if (typeof original !== 'function' || typeof AbortSignal?.timeout !== 'function') return;
  installed = true;
  globalThis.fetch = function patchedFetch(input: any, init?: any) {
    if (init?.signal) return original(input, init);
    return original(input, { ...(init ?? {}), signal: AbortSignal.timeout(ms) });
  } as typeof fetch;
}
