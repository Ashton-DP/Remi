/**
 * Remi Growth — generators (detect an opportunity → draft a proposal) and
 * executors (owner approved → do it). Each respects the clinic's guardrails;
 * discounts are always clamped to the owner's cap before anything goes out.
 */
import { computeFreeSlots } from './slots';
import { getBookingProvider } from './booking';
import { sendProactiveWhatsApp } from './twilio';
import { allowedDiscount, isEnabled, isAuto, type GrowthSettings } from './growth';
import {
  listWaitlist, getLapsedClients, markReactivated,
  createGrowthProposal, markGrowthProposalSent, hasOpenGrowthProposal,
  getCadenceOverdueClients, getRecentlyVisitedClients, getConsentedClients,
} from '../db';

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const GAP_MIN_OPEN = 3;     // don't bother the owner under this many open slots
const MAX_GAP_DAYS = 4;     // look this many days ahead
const MAX_TARGETS = 25;     // cap the offer blast

interface ProposalDraft { type: 'gap_fill'; title: string; detail: string; payload: any; expires_at?: string }

/** Does this clinic have a calendar Remi can trust for real availability? Without
 *  one, an unconnected diary looks "all open" and we'd propose phantom gaps. */
function hasUsableCalendar(clinic: any): boolean {
  return Boolean(clinic?.google_calendar_id) || Boolean(getBookingProvider(clinic)?.getAvailableSlots);
}

const niceDate = (dateStr: string, tz: string) =>
  new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-ZA', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'short' });

/** GAP-FILL generator: find near-term empty slots + who to offer them to. */
export async function generateGapFill(clinic: any): Promise<ProposalDraft | null> {
  if (!hasUsableCalendar(clinic)) return null;
  const tz = clinic.timezone ?? 'Africa/Johannesburg';
  const hours = clinic.hours_json ?? {};
  const defaultService = (clinic.services_json ?? [])[0]?.service;

  const openDays: { date: string; count: number; times: string[] }[] = [];
  for (let i = 1; i <= MAX_GAP_DAYS && openDays.length < 3; i++) {
    const dateStr = new Date(Date.now() + i * 86_400_000).toLocaleDateString('en-CA', { timeZone: tz });
    const weekday = WEEKDAYS[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
    if (!hours[weekday] || !hours[weekday].length) continue; // clinic closed that day
    let slots: string[] = [];
    try { slots = await computeFreeSlots(clinic, dateStr, defaultService); } catch { continue; }
    if (slots.length) openDays.push({ date: dateStr, count: slots.length, times: slots.slice(0, 3) });
  }
  const totalOpen = openDays.reduce((n, d) => n + d.count, 0);
  if (totalOpen < GAP_MIN_OPEN) return null;

  // Who to offer them to: waitlist first, then regulars overdue for a visit.
  const targets = new Map<string, { id: string; name: string; phone: string; source: string }>();
  for (const w of (await listWaitlist(clinic.id)) as any[]) {
    const c = w.clients; if (c?.phone && w.client_id) targets.set(w.client_id, { id: w.client_id, name: c.name ?? 'there', phone: c.phone, source: 'waitlist' });
  }
  for (const c of (await getLapsedClients(clinic.id, clinic.reactivation_days ?? 60, 20)) as any[]) {
    if (c.phone && !targets.has(c.id)) targets.set(c.id, { id: c.id, name: c.name ?? 'there', phone: c.phone, source: 'lapsed' });
  }
  const targetList = [...targets.values()].slice(0, MAX_TARGETS);
  if (!targetList.length) return null;

  const daysLabel = openDays.map((d) => `${d.count} on ${niceDate(d.date, tz)}`).join(', ');
  return {
    type: 'gap_fill',
    title: `Fill ${totalOpen} open slot${totalOpen > 1 ? 's' : ''} in the next few days`,
    detail: `Open: ${daysLabel}. I can offer them to ${targetList.length} ${targetList.length === 1 ? 'client' : 'clients'} (waitlist + regulars due for a visit). Add a discount if you'd like — or send it as-is.`,
    payload: { open_days: openDays, targets: targetList, suggested_discount_pct: 0 },
    // Stale once the soonest open day passes.
    expires_at: openDays[0] ? new Date(`${openDays[0].date}T23:59:59`).toISOString() : undefined,
  };
}

/** Execute an approved gap-fill: message the targets with the openings (+ any
 *  owner-approved discount, clamped to the cap). Returns what was sent. */
export async function executeGapFill(clinic: any, proposal: any, settings: GrowthSettings) {
  const owner = proposal.owner_input ?? {};
  const excluded: string[] = owner.excluded_ids ?? [];
  const discount = allowedDiscount(owner.discount_pct, settings);
  const targets: any[] = (proposal.payload?.targets ?? []).filter((t: any) => !excluded.includes(t.id));
  const days: any[] = proposal.payload?.open_days ?? [];
  const tz = clinic.timezone ?? 'Africa/Johannesburg';
  const whenLabel = days.length ? days.map((d) => niceDate(d.date, tz).replace(/,.*$/, '')).join(' & ') : 'this week';

  let sent = 0;
  for (const t of targets) {
    if (!t.phone) continue;
    const deal = discount > 0 ? ` — and ${discount}% off as a thank-you` : '';
    try {
      await sendProactiveWhatsApp(t.phone, {
        fallbackBody: `Hi ${t.name}! 👋 A few openings have just come up at ${clinic.name} (${whenLabel})${deal}. Would you like me to grab one for you? Reply here and I'll book you in 💛`,
      });
      sent++;
      if (t.source === 'lapsed') await markReactivated(t.id).catch(() => {}); // don't double-nudge via the reactivation job
    } catch (e) {
      console.error('[growth] gap-fill send failed', t.id, e);
    }
  }
  return { sent, targeted: targets.length, discount_pct: discount };
}

// ── WIN-BACKS (cadence-aware) ─────────────────────────────────────────────────
export async function generateWinback(clinic: any, settings: GrowthSettings): Promise<any | null> {
  const buffer = settings.winback.cadence_buffer_days ?? 14;
  const overdue = (await getCadenceOverdueClients(clinic.id, buffer, 15)) as any[];
  if (overdue.length < 2) return null; // not worth a campaign for one person
  const targets = overdue.map((c) => ({ id: c.id, name: c.name ?? 'there', phone: c.phone, source: 'cadence' }));
  return {
    type: 'winback',
    title: `Win back ${targets.length} regulars who are overdue`,
    detail: `These clients usually visit more often than they have lately — based on their own past rhythm, not a flat timer. I can send a warm “we’d love to see you” nudge. Add a comeback discount if you'd like.`,
    payload: { targets, suggested_discount_pct: 0 },
  };
}
export async function executeWinback(clinic: any, proposal: any, settings: GrowthSettings) {
  const owner = proposal.owner_input ?? {};
  const excluded: string[] = owner.excluded_ids ?? [];
  const discount = allowedDiscount(owner.discount_pct, settings);
  const targets: any[] = (proposal.payload?.targets ?? []).filter((t: any) => !excluded.includes(t.id));
  let sent = 0;
  for (const t of targets) {
    if (!t.phone) continue;
    const deal = discount > 0 ? ` We'd love to welcome you back with ${discount}% off your next visit.` : '';
    try {
      await sendProactiveWhatsApp(t.phone, {
        fallbackBody: `Hi ${t.name} 👋 It's been a little while since we saw you at ${clinic.name} — we'd love to have you back!${deal} Want me to find you a time? Just reply here 💛`,
      });
      sent++; await markReactivated(t.id).catch(() => {});
    } catch (e) { console.error('[growth] winback send failed', t.id, e); }
  }
  return { sent, targeted: targets.length, discount_pct: discount };
}

// ── OFF-PEAK OFFERS ───────────────────────────────────────────────────────────
export async function generateOffpeak(clinic: any, settings: GrowthSettings): Promise<any | null> {
  if (!settings.offpeak.windows?.trim()) return null;   // owner must define quiet times
  if (settings.max_discount_pct <= 0) return null;       // off-peak only makes sense with an incentive
  const clients = (await getConsentedClients(clinic.id, 60)) as any[];
  if (clients.length < 3) return null;
  const targets = clients.map((c) => ({ id: c.id, name: c.name ?? 'there', phone: c.phone, source: 'offpeak' }));
  return {
    type: 'offpeak',
    title: `Promote your quiet times (${settings.offpeak.windows})`,
    detail: `Fill your slow patch by offering a deal on ${settings.offpeak.windows} to ${targets.length} clients. Set the discount when you approve.`,
    payload: { windows: settings.offpeak.windows, targets, suggested_discount_pct: settings.max_discount_pct },
  };
}
export async function executeOffpeak(clinic: any, proposal: any, settings: GrowthSettings) {
  const owner = proposal.owner_input ?? {};
  const excluded: string[] = owner.excluded_ids ?? [];
  const discount = allowedDiscount(owner.discount_pct ?? proposal.payload?.suggested_discount_pct, settings);
  const windows = proposal.payload?.windows ?? 'our quiet times';
  const targets: any[] = (proposal.payload?.targets ?? []).filter((t: any) => !excluded.includes(t.id));
  let sent = 0;
  for (const t of targets) {
    if (!t.phone) continue;
    const deal = discount > 0 ? `${discount}% off` : 'a special rate';
    try {
      await sendProactiveWhatsApp(t.phone, {
        fallbackBody: `Hi ${t.name}! 🌟 This week ${clinic.name} has ${deal} on ${windows}. Want me to book you in? Just reply here 💛`,
      });
      sent++;
    } catch (e) { console.error('[growth] offpeak send failed', t.id, e); }
  }
  return { sent, targeted: targets.length, discount_pct: discount };
}

// ── REFERRALS ─────────────────────────────────────────────────────────────────
export async function generateReferral(clinic: any, settings: GrowthSettings): Promise<any | null> {
  if (!settings.referral.reward?.trim()) return null;    // owner must set the reward
  const clients = (await getRecentlyVisitedClients(clinic.id, 30, 20)) as any[];
  if (clients.length < 2) return null;
  const targets = clients.map((c) => ({ id: c.id, name: c.name ?? 'there', phone: c.phone, source: 'recent' }));
  return {
    type: 'referral',
    title: `Ask ${targets.length} happy clients to refer a friend`,
    detail: `Recently-served clients are your best advocates. I'll invite them to refer a friend with your reward: “${settings.referral.reward}”.`,
    payload: { reward: settings.referral.reward, targets },
  };
}
export async function executeReferral(clinic: any, proposal: any, _settings: GrowthSettings) {
  const owner = proposal.owner_input ?? {};
  const excluded: string[] = owner.excluded_ids ?? [];
  const reward = owner.reward ?? proposal.payload?.reward ?? '';
  const targets: any[] = (proposal.payload?.targets ?? []).filter((t: any) => !excluded.includes(t.id));
  let sent = 0;
  for (const t of targets) {
    if (!t.phone) continue;
    try {
      await sendProactiveWhatsApp(t.phone, {
        fallbackBody: `Hi ${t.name}! 💛 So glad you've been enjoying ${clinic.name}. Know someone who'd love us too? Refer a friend and ${reward} Just share our number with them — and tell us who sent them so we can say thanks!`,
      });
      sent++;
    } catch (e) { console.error('[growth] referral send failed', t.id, e); }
  }
  return { sent, targeted: targets.length, reward };
}

/** Dispatch: run an approved proposal's executor by type. Returns results. */
export async function executeGrowthProposal(clinic: any, proposal: any, settings: GrowthSettings): Promise<any> {
  switch (proposal.type) {
    case 'gap_fill': return executeGapFill(clinic, proposal, settings);
    case 'winback': return executeWinback(clinic, proposal, settings);
    case 'offpeak': return executeOffpeak(clinic, proposal, settings);
    case 'referral': return executeReferral(clinic, proposal, settings);
    default: return { error: `executor for ${proposal.type} not implemented yet` };
  }
}

/** Run the enabled generators for a clinic (called daily by the scheduler).
 *  Creates a pending proposal for the owner — or, if that type is set to auto,
 *  executes immediately within guardrails. Returns created proposals for notify. */
export async function runGrowthGenerators(clinic: any, settings: GrowthSettings): Promise<any[]> {
  const created: any[] = [];
  // type → its generator. (review routing isn't proposal-based; it's per-visit.)
  const generators: Record<string, () => Promise<any | null>> = {
    gap_fill: () => generateGapFill(clinic),
    winback: () => generateWinback(clinic, settings),
    offpeak: () => generateOffpeak(clinic, settings),
    referral: () => generateReferral(clinic, settings),
  };

  for (const [type, gen] of Object.entries(generators)) {
    try {
      if (!isEnabled(type as any, settings)) continue;
      if (await hasOpenGrowthProposal(clinic.id, type as any)) continue; // already one awaiting the owner
      const draft = await gen();
      if (!draft) continue;
      if (isAuto(type as any, settings)) {
        const p = await createGrowthProposal(clinic.id, { ...draft, status: 'pending' });
        await markGrowthProposalSent(p.id, await executeGrowthProposal(clinic, p, settings));
      } else {
        created.push(await createGrowthProposal(clinic.id, draft));
      }
    } catch (e) {
      console.error(`[growth] generator ${type} failed`, e);
    }
  }
  return created;
}
