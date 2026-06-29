/**
 * Dashboard JSON API (v1). All routes sit behind requireApiAuth and are scoped
 * to the caller's clinic. This is the read/control surface the master dashboard
 * SPA talks to. More endpoints land here as the dashboard phases roll out.
 */
import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { supabase } from '../lib/supabase';
import { getAuth, roleAtLeast } from '../lib/apiAuth';
import { qp } from '../lib/dashboardAuth';
import {
  getClinic, getTodaysBookings, countConversations, getChaseableInvoices, getOpenEscalations,
  listInvoices, getInvoiceForClinic, getInvoiceChases, listClinicBookings, listConversations,
  getConversationForClinic, getReportData, listClients,
  setChasingPaused, snoozeInvoice, markInvoicePaidById, disputeInvoice, resolveEscalation,
  updateClinicSettings, setInvoiceSource, setPaymentConfig, setEmailInbox,
  linkUserToClinic, listClinicUsers, setClinicUserRole, removeClinicUser, countClinicOwners,
  getOrCreateClient, setClientName, createBookingRow, scheduleReminders, cancelClinicBooking,
  listWaitlist, addWaitlistAtEnd, setWaitlistOrder, removeWaitlistEntry, getWaitlistEntry,
  isPlatformAdmin, listClinicsForAdmin,
  completeOnboarding, submitWhatsAppNumber,
  listStaff, addStaff, removeStaff, getClockedIn, getTimesheet, listLeaveRequests, decideLeave,
  addTask, listTasks, completeTask, deleteTask, addExpense, listExpenses,
  getClientProfile, updateClientProfile, listPackages, upsertPackage, listMemberships,
  createPendingMembership, getMembershipById, setMembershipStatus,
  getGrowthSettings, setGrowthSettings, listGrowthProposals, getGrowthProposal,
  decideGrowthProposal, countPendingGrowthProposals, markGrowthProposalSent,
  listReferrals, rewardReferral,
} from '../db';
import { mergeGrowthSettings, isEnabled } from '../lib/growth';
import { executeGrowthProposal } from '../lib/growthEngine';
import { sumHours, startOfWeek, formatHours } from '../lib/teamOps';
import { sendProactiveWhatsApp } from '../lib/twilio';
import { computeReportStats } from '../report';
import { computeInsights } from '../dashboard';
import { runAssistant } from '../brain/assistant';
import { getInvoiceSource } from '../lib/invoiceSources';
import { isAllowedSheetUrl } from '../lib/invoiceSources/googleSheet';
import { serviceAccountEmail, testCalendar } from '../lib/googleCalendar';
import { signState } from './connect';
import { config } from '../config';
import { membershipProvider, cancelMembershipSubscription } from '../lib/subscriptions';
import { getPaymentProvider, verifyPaymentCredentials } from '../lib/payments';

/** GET /api/me — who am I + which clinic/role. */
export async function handleMe(req: Request, res: Response) {
  const auth = getAuth(req);
  const clinic = await getClinic(auth.clinicId);
  res.json({
    user: { id: auth.userId, email: auth.email, role: auth.role },
    clinic: clinic ? { id: clinic.id, name: clinic.name, timezone: clinic.timezone ?? 'Africa/Johannesburg' } : null,
    plan: clinic?.plan ?? 'complete',
    is_platform_admin: await isPlatformAdmin(auth.userId),
    onboarding_completed: !!clinic?.onboarding_completed_at,
  });
}

/** GET /api/admin/clients — operator god-view: all clinics + rolled-up stats. */
export async function handleAdminClients(_req: Request, res: Response) {
  const clients = await listClinicsForAdmin();
  const totals = {
    clients: clients.length,
    bookings: clients.reduce((n, c) => n + (c.bookings || 0), 0),
    conversations: clients.reduce((n, c) => n + (c.conversations || 0), 0),
    open_escalations: clients.reduce((n, c) => n + (c.open_escalations || 0), 0),
    past_due: clients.filter((c) => c.subscription_status === 'past_due').length,
  };
  res.json({ clients, totals });
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
    // Connection health — so an owner who skipped steps knows what's still not
    // live, instead of assuming everything's set up.
    setup: {
      whatsapp_connected: !!clinic?.whatsapp_number && !clinic?.whatsapp_pending,
      whatsapp_pending: !!clinic?.whatsapp_pending,
      calendar_connected: !!clinic?.google_calendar_id,
      payment_connected: !!getPaymentProvider(clinic),
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

/** GET /api/customers/:id — full client profile. */
export async function handleCustomerProfile(req: Request, res: Response) {
  const auth = getAuth(req);
  const profile = await getClientProfile(String(req.params.id));
  if (!profile || profile.clinic_id !== auth.clinicId) return res.status(404).json({ error: 'Not found' });
  res.json({ customer: profile });
}

/** PATCH /api/customers/:id — update profile fields. Admin/owner only. */
export async function handleUpdateCustomer(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'Read-only access.' });
  const profile = await getClientProfile(String(req.params.id));
  if (!profile || profile.clinic_id !== auth.clinicId) return res.status(404).json({ error: 'Not found' });
  const allowed = ['notes', 'preferences', 'allergies', 'tags', 'birthday', 'anniversary', 'name', 'email'] as const;
  const updates: Record<string, any> = {};
  for (const k of allowed) { if (req.body?.[k] !== undefined) updates[k] = req.body[k]; }
  const updated = await updateClientProfile(profile.id, updates);
  res.json({ customer: updated });
}

/** GET /api/packages — all packages for this clinic. */
export async function handleListPackages(req: Request, res: Response) {
  const auth = getAuth(req);
  res.json({ packages: await listPackages(auth.clinicId) });
}

/** POST /api/packages — create a new package for a client. Admin/owner only. */
export async function handleCreatePackage(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'Read-only access.' });
  const { client_id, name, sessions_total, expires_at } = req.body ?? {};
  const total = Number(sessions_total);
  if (!client_id || !name) return res.status(400).json({ error: 'client_id and name are required.' });
  if (!Number.isInteger(total) || total <= 0) return res.status(400).json({ error: 'sessions_total must be a positive whole number.' });
  // Guard: the client must belong to this clinic (clinic_id is forced below, so a
  // foreign client_id would otherwise attach a package across tenants).
  const client = await getClientProfile(String(client_id));
  if (!client || client.clinic_id !== auth.clinicId) return res.status(404).json({ error: 'Client not found.' });
  const pkg = await upsertPackage(auth.clinicId, String(client_id), {
    name: String(name),
    sessions_total: total,
    expires_at: expires_at ?? undefined,
  });
  res.status(201).json({ package: pkg });
}

/** GET /api/growth — the Growth inbox: proposals + the clinic's guardrail settings. */
export async function handleGrowth(req: Request, res: Response) {
  const auth = getAuth(req);
  const [proposals, settings, pending, referrals] = await Promise.all([
    listGrowthProposals(auth.clinicId),
    getGrowthSettings(auth.clinicId),
    countPendingGrowthProposals(auth.clinicId),
    listReferrals(auth.clinicId),
  ]);
  res.json({ proposals, settings, pending, referrals });
}

/** POST /api/growth/referrals/:id/reward — mark a referral rewarded + thank the
 *  referrer over WhatsApp. Admin/owner only. */
export async function handleRewardReferral(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'Read-only access.' });
  const r = await rewardReferral(auth.clinicId, String(req.params.id));
  if (!r) return res.status(409).json({ error: 'Only a referral that has booked (and not yet been rewarded) can be rewarded.' });
  const phone = (r as any).referrer?.phone;
  const clinic = await getClinic(auth.clinicId);
  if (phone) {
    await sendProactiveWhatsApp(phone, {
      fallbackBody: `Thank you for referring a friend to ${clinic?.name ?? 'us'}! 🎉 Your reward: ${r.reward || 'a little something from us'}. We appreciate you 💛`,
    }).catch(() => {});
  }
  res.json({ referral: r });
}

/** POST /api/growth/:id/decide { action:'approve'|'decline', owner_input? } — owner
 *  approves a campaign and sets its specifics (discount, reward, excluded clients). */
export async function handleDecideGrowth(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'Read-only access.' });
  const proposal = await getGrowthProposal(auth.clinicId, String(req.params.id));
  if (!proposal) return res.status(404).json({ error: 'Not found.' });
  if (proposal.status !== 'pending') return res.status(409).json({ error: `Already ${proposal.status}.` });
  const action = String(req.body?.action ?? '');
  if (action !== 'approve' && action !== 'decline') return res.status(400).json({ error: "action must be 'approve' or 'decline'." });
  // Guardrail: clamp any owner-set discount to the clinic's max before saving.
  let ownerInput = req.body?.owner_input ?? undefined;
  if (ownerInput && ownerInput.discount_pct !== undefined) {
    const settings = await getGrowthSettings(auth.clinicId);
    ownerInput = { ...ownerInput, discount_pct: Math.min(Number(ownerInput.discount_pct) || 0, settings.max_discount_pct) };
  }
  const updated = await decideGrowthProposal(
    auth.clinicId, proposal.id, action === 'approve' ? 'approved' : 'declined', auth.email || auth.userId, ownerInput,
  );
  // Lost a concurrent decide race (row was no longer pending) — bail, don't execute.
  if (!updated) return res.status(409).json({ error: 'Already decided.' });
  // On approve, run it now (target lists are small) so the owner sees what went out.
  if (action === 'approve') {
    try {
      const [clinic, settings] = await Promise.all([getClinic(auth.clinicId), getGrowthSettings(auth.clinicId)]);
      // Re-check the feature is still enabled — the owner may have turned this growth
      // type off after the proposal was generated; don't run a now-disabled campaign.
      if (!isEnabled(updated.type, settings)) {
        return res.json({ proposal: updated, results: { skipped: 'this growth type is currently disabled' } });
      }
      const results = await executeGrowthProposal(clinic, updated, settings);
      const sent = await markGrowthProposalSent(updated.id, results);
      return res.json({ proposal: sent, results });
    } catch (e: any) {
      console.error('[growth] execute on approve failed', e?.message ?? e);
      return res.json({ proposal: updated, results: { error: 'queued — will run shortly' } });
    }
  }
  res.json({ proposal: updated });
}

/** POST /api/growth/settings — update the clinic's growth guardrails. Admin/owner only. */
export async function handleUpdateGrowthSettings(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'Read-only access.' });
  const settings = mergeGrowthSettings(req.body?.settings ?? req.body);
  await setGrowthSettings(auth.clinicId, settings);
  res.json({ settings });
}

/** GET /api/memberships — all memberships for this clinic. */
export async function handleListMemberships(req: Request, res: Response) {
  const auth = getAuth(req);
  res.json({ memberships: await listMemberships(auth.clinicId) });
}

/** POST /api/memberships — create a pending membership + return the signup link.
 *  The client opens the link, pays via the clinic's own recurring provider
 *  (Stripe/PayFast/Paystack), and it activates. Admin/owner only. */
export async function handleCreateMembership(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'Read-only access.' });
  const clinic = await getClinic(auth.clinicId);
  const provider = membershipProvider(clinic);
  if (!provider) {
    return res.status(400).json({ error: 'Memberships require Stripe, PayFast or Paystack. Connect one under Get Paid first.' });
  }
  const { client_id, plan_name, amount_zar, interval } = req.body ?? {};
  const amount = Number(amount_zar);
  if (!client_id || !plan_name || !(amount > 0)) {
    return res.status(400).json({ error: 'client_id, plan_name and a positive amount_zar are required.' });
  }
  const ivl = interval === 'year' ? 'year' : 'month';
  // Guard: the client must belong to this clinic.
  const client = await getClientProfile(String(client_id));
  if (!client || client.clinic_id !== auth.clinicId) return res.status(404).json({ error: 'Client not found.' });

  const membership = await createPendingMembership(auth.clinicId, String(client_id), {
    plan_name: String(plan_name), amount_zar: amount, interval: ivl, provider,
  });
  const signup_url = `${config.payments.publicBase}/membership/${membership.id}/start`;
  res.status(201).json({ membership, signup_url });
}

/** POST /api/memberships/:id/cancel — cancel future billing at the provider, then
 *  mark cancelled. We only mark cancelled if the provider cancel succeeds, so a
 *  client can't be marked cancelled while still being billed. Admin/owner only. */
export async function handleCancelMembership(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'Read-only access.' });
  const membership = await getMembershipById(String(req.params.id));
  if (!membership || membership.clinic_id !== auth.clinicId) return res.status(404).json({ error: 'Not found.' });
  const clinic = await getClinic(auth.clinicId);
  try {
    await cancelMembershipSubscription(clinic, membership);
  } catch (e: any) {
    return res.status(502).json({ error: `Could not cancel at provider: ${e?.message ?? 'failed'}` });
  }
  const updated = await setMembershipStatus(membership.id, 'cancelled');
  res.json({ membership: updated });
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
      google_calendar_id: c.google_calendar_id ?? '',
    },
    connections: {
      invoice_source: c.invoice_source ?? null,
      payment_provider: c.payment_provider ?? null,
      email_domain: c.email_domain ?? null,
      email_domain_status: c.email_domain_status ?? null,
      email_inbox: c.email_inbox?.user ?? null,
      chasing_paused: !!c.chasing_paused,
    },
    calendar: {
      service_account_email: serviceAccountEmail(),
      connected: !!c.google_calendar_id,
    },
  });
}

/** GET /api/calendar/test — verify the clinic's calendar is shared + reachable. */
export async function handleTestCalendar(req: Request, res: Response) {
  const auth = getAuth(req);
  const c = await getClinic(auth.clinicId);
  // Accept an unsaved calendar id (onboarding tests before saving); fall back to
  // the saved one for the Settings "test connection" button.
  const calId = qp(req.query.calendar_id) || c?.google_calendar_id;
  const result = await testCalendar(calId);
  res.json(result);
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
  if (!isAllowedSheetUrl(url)) return res.status(400).json({ error: 'A published-to-web Google Sheets CSV URL (docs.google.com) is required.' });
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
  // Validate the credentials live before saving — don't let a clinic go "live"
  // with a broken/test key that fails silently at the customer's checkout.
  try {
    await verifyPaymentCredentials(provider as any, cfg);
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || 'Those payment details did not verify.' });
  }
  await setPaymentConfig(auth.clinicId, provider, { [provider]: cfg });
  res.json({ ok: true });
}

/** Connect (or disconnect) the clinic's own email inbox — Remi reads + replies to
 *  booking emails via IMAP/SMTP. The app-password is write-only (never returned). */
export async function handleConnectEmailInbox(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const b = req.body ?? {};
  if (b.disconnect) { await setEmailInbox(auth.clinicId, null); return res.json({ ok: true, connected: false }); }
  const required = ['imap_host', 'smtp_host', 'user', 'pass'];
  for (const f of required) if (!String(b[f] ?? '').trim()) return res.status(400).json({ error: `Missing ${f}` });
  await setEmailInbox(auth.clinicId, {
    imap_host: String(b.imap_host).trim(),
    imap_port: b.imap_port ? parseInt(String(b.imap_port), 10) : 993,
    smtp_host: String(b.smtp_host).trim(),
    smtp_port: b.smtp_port ? parseInt(String(b.smtp_port), 10) : 465,
    user: String(b.user).trim(),
    pass: String(b.pass),
    from_name: String(b.from_name ?? '').trim() || undefined,
    enabled: true,
  });
  res.json({ ok: true, connected: true });
}

// ---- Team Ops ---------------------------------------------------------------

/** Team Ops overview: who's clocked in, weekly hours per staff, leave inbox, roster. */
export async function handleTeamOps(req: Request, res: Response) {
  const auth = getAuth(req);
  const sinceISO = new Date(startOfWeek()).toISOString();
  const [staff, clockedIn, timesheet, leave] = await Promise.all([
    listStaff(auth.clinicId), getClockedIn(auth.clinicId), getTimesheet(auth.clinicId, sinceISO), listLeaveRequests(auth.clinicId),
  ]);
  const byStaff: Record<string, { name: string; entries: { clock_in: string; clock_out: string | null }[] }> = {};
  for (const e of timesheet as any[]) {
    const s = e.staff; if (!s?.id) continue;
    (byStaff[s.id] ??= { name: s.name, entries: [] }).entries.push({ clock_in: e.clock_in, clock_out: e.clock_out });
  }
  const hours = Object.entries(byStaff).map(([id, v]) => {
    const h = sumHours(v.entries);
    return { staff_id: id, name: v.name, hours: h, label: formatHours(h) };
  }).sort((a, b) => b.hours - a.hours);
  res.json({
    role: auth.role,
    clocked_in: (clockedIn as any[]).map((c) => ({ name: c.staff?.name, since: c.clock_in })),
    hours,
    leave: (leave as any[]).map((l) => ({ id: l.id, name: l.staff?.name, start: l.start_date, end: l.end_date, type: l.type, reason: l.reason, status: l.status })),
    staff: (staff as any[]).map((s) => ({ id: s.id, name: s.name, phone: s.phone, role: s.role, active: s.active })),
  });
}

export async function handleAddStaff(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const b = req.body ?? {};
  if (!String(b.name ?? '').trim()) return res.status(400).json({ error: 'Name is required' });
  const s = await addStaff(auth.clinicId, { name: String(b.name).trim(), phone: b.phone ? String(b.phone).trim() : undefined, role: b.role, pay_rate: b.pay_rate ? Number(b.pay_rate) : undefined });
  res.json({ ok: true, staff: s });
}

export async function handleRemoveStaff(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  await removeStaff(auth.clinicId, String(req.params.id));
  res.json({ ok: true });
}

export async function handleDecideLeave(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const status = req.body?.status === 'approved' ? 'approved' : 'declined';
  const row: any = await decideLeave(auth.clinicId, String(req.params.id), status, auth.email ?? 'owner');
  // Let the staff member know the outcome (best-effort).
  try {
    const phone = row?.staff?.phone;
    if (phone) await sendProactiveWhatsApp(phone, { fallbackBody: `Your leave request (${row.start_date}${row.end_date !== row.start_date ? ` → ${row.end_date}` : ''}) was ${status}.` });
  } catch { /* non-blocking */ }
  res.json({ ok: true, status });
}

// ---- Tasks & expenses (quick wins) ------------------------------------------

export async function handleTasks(req: Request, res: Response) {
  const auth = getAuth(req);
  const sinceISO = new Date(startOfWeek()).toISOString();
  const [tasks, expenses] = await Promise.all([listTasks(auth.clinicId), listExpenses(auth.clinicId, sinceISO)]);
  const weekTotal = (expenses as any[]).reduce((s, e) => s + Number(e.amount_zar || 0), 0);
  res.json({ role: auth.role, tasks, expenses, expenses_week_total: weekTotal });
}

export async function handleAddTask(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const b = req.body ?? {};
  if (!String(b.title ?? '').trim()) return res.status(400).json({ error: 'Title is required' });
  const t = await addTask(auth.clinicId, { title: String(b.title).trim(), note: b.note, assignee: b.assignee, due_at: b.due_at, source: 'dashboard' });
  res.json({ ok: true, task: t });
}

export async function handleCompleteTask(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  await completeTask(auth.clinicId, String(req.params.id));
  res.json({ ok: true });
}

export async function handleDeleteTask(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  await deleteTask(auth.clinicId, String(req.params.id));
  res.json({ ok: true });
}

export async function handleAddExpense(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const amount = Number(req.body?.amount_zar);
  if (!amount || amount <= 0) return res.status(400).json({ error: 'A positive amount is required' });
  const e = await addExpense(auth.clinicId, { amount_zar: amount, description: req.body?.description, category: req.body?.category, logged_by: auth.email ?? 'dashboard' });
  res.json({ ok: true, expense: e });
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

// ── Appointments: create + cancel (Basic clinic tier) — admin/owner only ─────

/** POST /api/bookings { client_name, phone, service, start_at, duration_min } */
export async function handleCreateBooking(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const name = String(req.body?.client_name ?? '').trim();
  const phone = String(req.body?.phone ?? '').trim();
  const service = String(req.body?.service ?? '').trim();
  const startAt = String(req.body?.start_at ?? '');
  const dur = Number(req.body?.duration_min) > 0 ? Number(req.body.duration_min) : 30;
  if (!service || !startAt || (!phone && !name)) return res.status(400).json({ error: 'Service, time and a contact are required.' });
  const startDate = new Date(startAt);
  if (isNaN(startDate.getTime())) return res.status(400).json({ error: 'Invalid date/time.' });

  const { client } = await getOrCreateClient(auth.clinicId, phone || `walkin-${Date.now()}`);
  if (name) await setClientName(client.id, name);
  const endAt = new Date(startDate.getTime() + dur * 60_000).toISOString();
  const booking = await createBookingRow({ clinicId: auth.clinicId, clientId: client.id, service, startAt: startDate.toISOString(), endAt, calendarEventId: 'manual', source: 'dashboard' });
  await scheduleReminders(booking.id, startDate.toISOString()).catch(() => {});
  res.json({ ok: true });
}

/** POST /api/bookings/:id/cancel */
export async function handleCancelBooking(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const ok = await cancelClinicBooking(auth.clinicId, String(req.params.id));
  res.json({ ok });
}

// ── Waitlist: list / add / reorder / remove / book (Basic clinic tier) ────────

/** GET /api/waitlist — active entries in manual-priority order. */
export async function handleWaitlist(req: Request, res: Response) {
  const auth = getAuth(req);
  const waitlist = await listWaitlist(auth.clinicId);
  res.json({ waitlist });
}

/** POST /api/waitlist { client_name, phone, service, preferred_window } */
export async function handleAddWaitlist(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const name = String(req.body?.client_name ?? '').trim();
  const phone = String(req.body?.phone ?? '').trim();
  const service = String(req.body?.service ?? '').trim();
  const pref = String(req.body?.preferred_window ?? '').trim() || undefined;
  if (!service || (!phone && !name)) return res.status(400).json({ error: 'Service and a contact are required.' });
  const { client } = await getOrCreateClient(auth.clinicId, phone || `waitlist-${Date.now()}`);
  if (name) await setClientName(client.id, name);
  await addWaitlistAtEnd(auth.clinicId, client.id, service, pref);
  res.json({ ok: true });
}

/** POST /api/waitlist/:id/move { direction: 'up' | 'down' } */
export async function handleMoveWaitlist(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const dir = req.body?.direction === 'up' ? 'up' : 'down';
  const ids = (await listWaitlist(auth.clinicId)).map((e: any) => e.id);
  const idx = ids.indexOf(String(req.params.id));
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const swap = dir === 'up' ? idx - 1 : idx + 1;
  if (swap >= 0 && swap < ids.length) {
    [ids[idx], ids[swap]] = [ids[swap], ids[idx]];
    try { await setWaitlistOrder(auth.clinicId, ids); }
    catch (e: any) { return res.status(400).json({ error: e.message }); }
  }
  res.json({ ok: true });
}

/** DELETE /api/waitlist/:id */
export async function handleRemoveWaitlist(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  await removeWaitlistEntry(auth.clinicId, String(req.params.id));
  res.json({ ok: true });
}

/** POST /api/waitlist/:id/book { start_at, duration_min } — convert to an appointment. */
export async function handleBookWaitlist(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'admin')) return res.status(403).json({ error: 'You have read-only access.' });
  const entry: any = await getWaitlistEntry(auth.clinicId, String(req.params.id));
  if (!entry) return res.status(404).json({ error: 'Not found' });
  const startAt = String(req.body?.start_at ?? '');
  const dur = Number(req.body?.duration_min) > 0 ? Number(req.body.duration_min) : 30;
  const startDate = new Date(startAt);
  if (isNaN(startDate.getTime())) return res.status(400).json({ error: 'Invalid date/time.' });
  const endAt = new Date(startDate.getTime() + dur * 60_000).toISOString();
  const booking = await createBookingRow({ clinicId: auth.clinicId, clientId: entry.client_id, service: entry.service, startAt: startDate.toISOString(), endAt, calendarEventId: 'manual', source: 'waitlist' });
  await scheduleReminders(booking.id, startDate.toISOString()).catch(() => {});
  await removeWaitlistEntry(auth.clinicId, String(req.params.id));
  res.json({ ok: true });
}

// ── Onboarding ────────────────────────────────────────────────────────────────

/** POST /api/onboarding/complete — marks setup done; saves settings in one shot. */
export async function handleCompleteOnboarding(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'owner')) return res.status(403).json({ error: 'Owner only.' });
  // Save all clinic settings submitted from the wizard
  if (req.body && Object.keys(req.body).length) {
    await updateClinicSettings(auth.clinicId, req.body);
  }
  await completeOnboarding(auth.clinicId);
  res.json({ ok: true });
}

/** POST /api/onboarding/whatsapp { number } — saves clinic WhatsApp number + alerts operator. */
export async function handleSubmitWhatsApp(req: Request, res: Response) {
  const auth = getAuth(req);
  if (!roleAtLeast(auth.role, 'owner')) return res.status(403).json({ error: 'Owner only.' });
  const raw = String(req.body?.number ?? '').trim().replace(/\s/g, '');
  if (!raw) return res.status(400).json({ error: 'A WhatsApp number is required.' });
  // Normalise to E.164 (+27…)
  const number = raw.startsWith('+') ? raw : `+${raw}`;
  await submitWhatsAppNumber(auth.clinicId, number);
  // Alert operator (Ashton) via WhatsApp so he can connect it in Twilio
  const clinic = await getClinic(auth.clinicId);
  const operatorPhone = config.operatorAlertPhone;
  if (operatorPhone) {
    await sendProactiveWhatsApp(operatorPhone, {
      fallbackBody: `🔔 New WhatsApp setup request\nClinic: ${clinic?.name ?? auth.clinicId}\nNumber: ${number}\nAction: Add this number as a WhatsApp sender in Twilio, then forward the OTP to the clinic.`,
    }).catch((e) => console.error('[whatsapp-alert]', e));
  }
  res.json({ ok: true });
}
