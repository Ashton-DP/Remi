/**
 * Remi Growth — owner-guided campaign logic, split from db.ts so the defaults +
 * guardrail math are pure and testable. Remi proposes; the owner approves the
 * specifics; Remi never exceeds these guardrails.
 */

export type GrowthType = 'gap_fill' | 'winback' | 'referral' | 'review' | 'offpeak';
export type Approval = 'ask' | 'auto';

export interface GrowthSettings {
  max_discount_pct: number;
  gap_fill: { enabled: boolean; approval: Approval };
  winback: { enabled: boolean; approval: Approval; cadence_buffer_days: number };
  referral: { enabled: boolean; reward: string };
  review: { enabled: boolean };
  offpeak: { enabled: boolean; approval: Approval; windows: string };
}

/** Conservative defaults: nothing auto, no discounts, growth types that send
 *  cold outreach (referral/offpeak) OFF until the owner opts in. */
export const DEFAULT_GROWTH_SETTINGS: GrowthSettings = {
  max_discount_pct: 0,
  gap_fill: { enabled: true, approval: 'ask' },
  winback: { enabled: true, approval: 'ask', cadence_buffer_days: 14 },
  referral: { enabled: false, reward: '' },
  review: { enabled: true },
  offpeak: { enabled: false, approval: 'ask', windows: '' },
};

/** Merge a clinic's stored settings over the defaults (deep, one level). Pure. */
export function mergeGrowthSettings(stored: Partial<GrowthSettings> | null | undefined): GrowthSettings {
  const s = stored ?? {};
  const d = DEFAULT_GROWTH_SETTINGS;
  return {
    max_discount_pct: clampPct((s as any).max_discount_pct ?? d.max_discount_pct),
    gap_fill: { ...d.gap_fill, ...(s.gap_fill ?? {}) },
    winback: { ...d.winback, ...(s.winback ?? {}) },
    referral: { ...d.referral, ...(s.referral ?? {}) },
    review: { ...d.review, ...(s.review ?? {}) },
    offpeak: { ...d.offpeak, ...(s.offpeak ?? {}) },
  };
}

/** Clamp a percentage to [0, 100]. Pure. */
export function clampPct(n: any): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** The discount Remi may actually use: requested, but never above the owner's cap.
 *  Returns 0 if discounts aren't allowed. Pure — the core guardrail. */
export function allowedDiscount(requestedPct: any, settings: GrowthSettings): number {
  return Math.min(clampPct(requestedPct), clampPct(settings.max_discount_pct));
}

/** Whether a growth type acts immediately (auto) or waits for owner approval. Pure. */
export function isAuto(type: GrowthType, settings: GrowthSettings): boolean {
  const cfg: any = (settings as any)[type];
  return cfg?.approval === 'auto';
}

/** Whether a growth type is enabled for this clinic. Pure. */
export function isEnabled(type: GrowthType, settings: GrowthSettings): boolean {
  return Boolean(((settings as any)[type] ?? {}).enabled);
}
