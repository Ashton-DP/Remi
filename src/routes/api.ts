/**
 * Dashboard JSON API (v1). All routes sit behind requireApiAuth and are scoped
 * to the caller's clinic. This is the read/control surface the master dashboard
 * SPA talks to. More endpoints land here as the dashboard phases roll out.
 */
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { supabase } from '../lib/supabase';
import { getAuth, roleAtLeast } from '../lib/apiAuth';
import {
  getClinic, getTodaysBookings, countConversations, getChaseableInvoices, getOpenEscalations,
  listInvoices, getInvoiceForClinic, getInvoiceChases, listClinicBookings, listConversations,
  getConversationForClinic, getReportData, listClients,
  setChasingPaused, snoozeInvoice, markInvoicePaidById, disputeInvoice, resolveEscalation,
  updateClinicSettings, setInvoiceSource, setPaymentConfig,
  linkUserToClinic, listClinicUsers, setClinicUserRole, removeClinicUser, countClinicOwners,
} from '../db';
import { computeReportStats } from '../report';
import { computeInsights } from '../dashboard';
import { runAssistant } from '../brain/assistant';
import { getInvoiceSource } from '../lib/invoiceSources';
import { signState } from './connect';
import { config } from '../config';

/** GET /api/me — who am I + which clinic/role. */
export async function handleMe(req: Request, res: Response) {
  const auth = getAuth(req);
  const clinic = await getClinic(auth.clinicId);
  res.json({
    user: { id: auth.userId, email: auth.email, role: auth.role },
    clinic: clinic ? { id: clinic.id, name: clinic.name, timezone: clinic.timezone ?? 'Africa/Johannesburg' } : null,
  });
}

/** GET /api/today — the home "pulse" summary for the caller's clinic. */
export async function handleToday(req: Request, res: Response) {
  const auth = getAuth(req);
  const clinic = await getClinic(auth.clinicId);
  const tz = clinic?.timezone ?? 'Africa/Johannesburg';
  const since24h = new Date(Date.now() - 24 * 3_600_000).toISOString();

  const [bookings, convCount, overdue, escalations] = await Promise.all([
    getTodaysBookings(auth.clinicId, tz),
    countConversations(auth.clinicId, since24h),
    getChaseableInvoices(auth.clinicId),
    getOpenEscalations(auth.clinicId),
  ]);

  const overdueTotal = (overdue as any[]).reduce((s, i) => s + (Number(i.amount_due) || 0), 0);

  res.json({
    clinic: clinic ? { name: clinic.name, chasing_paused: !!clinic.chasing_paused } : null,
    today: {
      appointments: (bookings as any[]).length,
      conversations_24h: convCount,
      overdue_invoices: (overdue as any[]).length,
      overdue_total_zar: overdueTotal,
      open_escalations: (escalations as any[]).length,
    },
    needs_you: (escalations as any[]).slice(0, 10).map((e: any) => ({
      id: e.id, reason: e.reason, summary: e.summary, created_at: e.created_at,
    })),
  });
}

// ── Phase 2 read views ───────────────────────────────────────────────────────

/** GET /api/invoices — the Get-Paid list + whether chasing is paused. */
export async function handleInvoices(req: Request, res: Response) {
  const auth = getAuth(req);
  const [invoices, clinic] = await Promise.all([listInvoices(auth.clinicId), getClinic(auth.clinicId)]);
  res.json({ invoices, chasing_paused: !!clinic?.chasing_paused });
}

/** GET /api/invoices/:id — one invoice + its chase timeline. */
export async function handleInvoiceDetail(req: Request, res: Response) {
  const auth = getAuth(req);
  const inv = await getInvoiceForClinic(auth.clinicId, String(req.params.id));
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const chases = await getInvoiceChases(inv.id);
  res.json({ invoice: inv, chases });
}

/** GET /api/bookings — recent + upcoming appointments. */
export async function handleBookings(req: Request, res: Response) {
  const auth = getAuth(req);
  res.json({ bookings: await listClinicBookings(auth.clinicId) });
}

/** GET /api/conversations — the inbox list. */
export async function handleConversations(req: Request, res: Response) {
  const auth = getAuth(req);
  res.json({ conversations: await listConversations(auth.clinicId) });
}

/** GET /api/conversations/:id — a transcript. */
export async function handleConversationDetail(req: Request, res: Response) {
  const auth = getAuth(req);
  const out = await getConversationForClinic(auth.clinicId, String(req.params.id));
  if (!out) return res.status(404).json({ error: 'Conversation not found' });
  res.json(out);
}

/** GET /api/insights — last-30-day performance. */
export async function handleInsights(req: Request, res: Response) {
  const auth = getAuth(req);
  const sinceISO = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { events, bookings } = await getReportData(auth.clinicId, sinceISO);
  const convCount = await countConversations(auth.clinicId, sinceISO);
  const stats = computeReportStats(events as any[], bookings as any[]);
  const insights = computeInsights(bookings as any[], convCount, stats.bookedN);
  res.json({ stats, insights, conversations_30d: convCount });
}

/** POST /api/assistant — talk to the Remi copilot. Body: { messages:[{role,content}] }. */
export async function handleAssistant(req: Request, res: Response) {
  const auth = getAuth(req);
  const clinic = await getClinic(auth.clinicId);
  if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: 'messages required' });
  try {
    const reply = await runAssistant(clinic, auth.role, messages);
    res.json({ reply });
  } catch (e: any) {
    console.error('[assistant]', e?.message ?? e);
    res.status(502).json({ error: 'The assistant had trouble — please try again.' });
  }
}

// ── Phase 3 controls (write actions) + Customers ─────────────────────────────

/** GET /api/customers — the clinic's contacts. */
export async function handleCustomers(req: Request, res: Response) {
  const auth = getAuth(req);
  res.json({ customers: await listClients(auth.clinicId) });
}

/** POST /api/chasing { paused:boolean } — global kill switch. Admin/owner only. */
export async function handleSetChasing(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const paused = !!req.body?.paused;
  await setChasingPaused(auth.clinicId, paused);
  res.json({ ok: true, paused });
}

/** POST /api/invoices/:id/action { action:'paid'|'snooze'|'dispute', days? }. Admin/owner only. */
export async function handleInvoiceActionWrite(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const inv = await getInvoiceForClinic(auth.clinicId, String(req.params.id));
  if (!inv) return res.status(404).json({ error: 'Invoice not found' });
  const action = String(req.body?.action ?? '');
  if (action === 'paid') await markInvoicePaidById(inv.id);
  else if (action === 'dispute') await disputeInvoice(inv.id);
  else if (action === 'snooze') {
    const days = Number(req.body?.days) > 0 ? Number(req.body.days) : 5;
    await snoozeInvoice(inv.id, new Date(Date.now() + days * 86_400_000).toISOString());
  } else return res.status(400).json({ error: 'Unknown action' });
  res.json({ ok: true, action });
}

/** POST /api/escalations/:id/resolve — mark a "needs you" item resolved. Admin/owner only. */
export async function handleResolveEscalation(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const ok = await resolveEscalation(auth.clinicId, String(req.params.id));
  res.json({ ok });
}

// ── Settings ─────────────────────────────────────────────────────────────────

/** GET /api/settings — editable clinic fields + read-only connection status.
 *  Never returns tokens/secrets. */
export async function handleSettings(req: Request, res: Response) {
  const auth = getAuth(req);
  const c = await getClinic(auth.clinicId);
  if (!c) return res.status(404).json({ error: 'Clinic not found' });
  res.json({
    role: auth.role,
    clinic: {
      name: c.name ?? '', timezone: c.timezone ?? 'Africa/Johannesburg',
      knowledge: c.knowledge ?? '', owner_summary_phone: c.owner_summary_phone ?? '',
      escalation_contact: c.escalation_contact ?? '', chase_cadence: c.chase_cadence ?? null,
      chase_reply_to: c.chase_reply_to ?? '',
      services: c.services_json ?? [], hours: c.hours_json ?? {},
    },
    connections: {
      invoice_source: c.invoice_source ?? null,
      payment_provider: c.payment_provider ?? null,
      email_domain: c.email_domain ?? null,
      email_domain_status: c.email_domain_status ?? null,
      chasing_paused: !!c.chasing_paused,
    },
  });
}

/** POST /api/settings — update whitelisted clinic fields. Admin/owner only. */
export async function handleUpdateSettings(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  await updateClinicSettings(auth.clinicId, req.body ?? {});
  res.json({ ok: true });
}

// ── Self-serve connections (dashboard-authed; admin/owner only) ──────────────

/** GET /api/connect/:provider/start — OAuth authorize URL for Xero/QBO/Sage. */
export async function handleConnectStartAuthed(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const provider = String(req.params.provider);
  const src = getInvoiceSource(provider);
  if (!src || src.kind !== 'oauth' || !src.getAuthUrl) return res.status(400).json({ error: 'Unknown provider' });
  const creds = (config.invoiceSources as any)[provider];
  if (!creds?.clientId) return res.status(503).json({ error: `${src.label} isn't configured on the server yet.` });
  res.json({ url: src.getAuthUrl(signState(auth.clinicId)) });
}

/** POST /api/connect/gsheet { sheet_url } — connect a published-CSV Google Sheet. */
export async function handleConnectSheetAuthed(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const url = String(req.body?.sheet_url ?? '').trim();
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'A published-to-web CSV URL is required.' });
  await setInvoiceSource(auth.clinicId, 'gsheet', null, { sheet_url: url });
  res.json({ ok: true });
}

/** POST /api/connect/payment { provider, config } — set the clinic's payment rail. */
export async function handleConnectPayment(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const provider = String(req.body?.provider ?? '');
  const cfg = req.body?.config ?? {};
  if (!['payfast', 'paystack', 'stripe', 'paypal', 'link'].includes(provider)) return res.status(400).json({ error: 'Unknown provider' });
  await setPaymentConfig(auth.clinicId, provider, { [provider]: cfg });
  res.json({ ok: true });
}

// ── Team / users (owner only for writes) ─────────────────────────────────────

const ROLES = ['owner', 'admin', 'staff'];

/** GET /api/team — clinic members with emails. */
export async function handleTeam(req: Request, res: Response) {
  const auth = getAuth(req);
  const members = await listClinicUsers(auth.clinicId);
  const out: any[] = [];
  for (const m of members as any[]) {
    let email: string | null = null;
    try { const { data } = await supabase.auth.admin.getUserById(m.user_id); email = data.user?.email ?? null; } catch { /* ignore */ }
    out.push({ user_id: m.user_id, role: m.role, email, you: m.user_id === auth.userId });
  }
  res.json({ members: out, can_manage: roleAtLeast(auth.role, 'owner') });
}

/** POST /api/team/invite { email, role } — create + link a member. Returns a temp password. */
export async function handleTeamInvite(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'owner')) return res.status(403).json({ error: 'Only an owner can add team members.' });
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const role = ROLES.includes(req.body?.role) ? req.body.role : 'staff';
  if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required.' });

  const password = crypto.randomBytes(9).toString('base64url');
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) {
    if (/registered|already|exists/i.test(error.message)) {
      const { data: list } = await supabase.auth.admin.listUsers();
      const u = (list?.users ?? []).find((x: any) => (x.email || '').toLowerCase() === email);
      if (!u) return res.status(502).json({ error: 'That user exists but could not be located.' });
      await linkUserToClinic(u.id, auth.clinicId, role);
      return res.json({ ok: true, existing: true, email });
    }
    return res.status(502).json({ error: error.message });
  }
  await linkUserToClinic(data.user!.id, auth.clinicId, role);
  res.json({ ok: true, email, temp_password: password });
}

/** POST /api/team/:userId/role { role }. Owner only; can't demote the only owner. */
export async function handleTeamRole(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'owner')) return res.status(403).json({ error: 'Only an owner can change roles.' });
  const userId = String(req.params.userId);
  const role = ROLES.includes(req.body?.role) ? req.body.role : null;
  if (!role) return res.status(400).json({ error: 'Invalid role' });
  if (role !== 'owner') {
    const members = await listClinicUsers(auth.clinicId);
    const target = (members as any[]).find((m) => m.user_id === userId);
    if (target?.role === 'owner' && (await countClinicOwners(auth.clinicId)) <= 1) return res.status(400).json({ error: "You can't demote the only owner." });
  }
  await setClinicUserRole(auth.clinicId, userId, role);
  res.json({ ok: true });
}

/** DELETE /api/team/:userId — remove from the clinic. Owner only; not self/last owner. */
export async function handleTeamRemove(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'owner')) return res.status(403).json({ error: 'Only an owner can remove members.' });
  const userId = String(req.params.userId);
  if (userId === auth.userId) return res.status(400).json({ error: "You can't remove yourself." });
  const members = await listClinicUsers(auth.clinicId);
  const target = (members as any[]).find((m) => m.user_id === userId);
  if (target?.role === 'owner' && (await countClinicOwners(auth.clinicId)) <= 1) return res.status(400).json({ error: "Can't remove the only owner." });
  await removeClinicUser(auth.clinicId, userId);
  res.json({ ok: true });
}
