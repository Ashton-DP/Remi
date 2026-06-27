/**
 * Client OS pure logic — package math + membership status mapping, split from
 * db.ts / the scheduler so it's testable in Node with no Supabase or Stripe.
 */

export interface PackageLite {
  sessions_total: number;
  sessions_used: number;
  expires_at?: string | null;
}

/** Sessions left on a package (never negative). Pure. */
export function sessionsRemaining(p: PackageLite): number {
  return Math.max(0, (p.sessions_total ?? 0) - (p.sessions_used ?? 0));
}

/** Is a package still usable right now (sessions left AND not expired)? Pure. */
export function isPackageActive(p: PackageLite, now: number = Date.now()): boolean {
  if (sessionsRemaining(p) <= 0) return false;
  if (p.expires_at) {
    const exp = new Date(p.expires_at).getTime();
    if (!isNaN(exp) && exp <= now) return false;
  }
  return true;
}

/** Should we nudge this client to rebook? Active package at/under threshold. Pure. */
export function isLowPackage(p: PackageLite, threshold = 2, now: number = Date.now()): boolean {
  if (!isPackageActive(p, now)) return false;
  return sessionsRemaining(p) <= threshold;
}

export type MembershipStatus = 'active' | 'past_due' | 'paused' | 'cancelled';

/** Map a Stripe subscription.status to our membership enum. Pure. */
export function mapStripeSubStatus(stripeStatus: string): MembershipStatus {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
    case 'incomplete':
      return 'past_due';
    case 'paused':
      return 'paused';
    // canceled, incomplete_expired, and anything unknown → cancelled
    default:
      return 'cancelled';
  }
}
