import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { config, assertProductionConfig } from './config';
import { installFetchTimeout } from './lib/httpTimeout';
import { handleInboundWhatsApp } from './routes/whatsapp';
import { handleInboundCall, handleVoiceGather, handleCallStatus } from './routes/voice';
import { generateReport, renderReportPage } from './report';
import { renderDashboard } from './dashboard';
import { supabase } from './lib/supabase';
import { validateTwilioWebhook } from './lib/twilioWebhook';
import { requireDashboardAuth, qp } from './lib/dashboardAuth';
import { initMonitoring, attachErrorHandler } from './lib/monitoring';
import { rateLimit } from './lib/rateLimit';
import { requestLogger } from './lib/logger';
import { startScheduler } from './scheduler';
import { attachVoiceRelay } from './routes/voiceRelay';
import { attachMediaStream } from './routes/mediaStream';
import { handleAgentTool } from './routes/agentTools';
import { handleOnboard } from './routes/onboard';
import { renderIntakeForm, handleIntakeSubmit } from './routes/intake';
import { handleStripeWebhook } from './routes/stripeWebhook';
import { handleInvoiceImport, handleInvoiceList, handleSourcePreview } from './routes/invoices';
import { handleConnectStart, handleConnectCallback, handleConnectSheet } from './routes/connect';
import { handleEmailDomainSetup, handleEmailDomainVerify, handleEmailDomainStatus } from './routes/emailDomain';
import { handlePay, handlePaySuccess, handlePayCancel, handlePayfastNotify, handleStripeReturn, handlePaypalReturn, handlePaystackReturn } from './routes/pay';
import { requireApiAuth, requirePlatformAdmin } from './lib/apiAuth';
import {
  handleMe, handleToday, handleInvoices, handleInvoiceDetail, handleBookings,
  handleConversations, handleConversationDetail, handleInsights, handleAssistant,
  handleCustomers, handleCustomerProfile, handleUpdateCustomer,
  handleSetChasing, handleInvoiceActionWrite, handleResolveEscalation,
  handleSettings, handleUpdateSettings, handleTestCalendar,
  handleConnectStartAuthed, handleConnectSheetAuthed, handleConnectPayment, handleConnectEmailInbox,
  handleTeamOps, handleAddStaff, handleRemoveStaff, handleDecideLeave,
  handleTasks, handleAddTask, handleCompleteTask, handleDeleteTask, handleAddExpense,
  handleTeam, handleTeamInvite, handleTeamRole, handleTeamRemove,
  handleCreateBooking, handleCancelBooking,
  handleWaitlist, handleAddWaitlist, handleMoveWaitlist, handleRemoveWaitlist, handleBookWaitlist,
  handleAdminClients,
  handleCompleteOnboarding, handleSubmitWhatsApp,
  handleListPackages, handleCreatePackage, handleListMemberships,
  handleCreateMembership, handleCancelMembership,
} from './routes/api';
import { handleMembershipStart, handleMembershipReturn } from './routes/membership';

// Bound every outbound fetch so a hung dependency can't stall a request, and fail
// fast if a critical production env var is missing (rather than booting broken).
installFetchTimeout();
assertProductionConfig();

const app = express();
// Render/Railway terminate TLS and forward — trust the proxy so forwarded
// host/proto are honoured (needed for correct Twilio signature validation).
app.set('trust proxy', true);
// Stripe webhook needs the RAW body for signature verification — must be mounted
// BEFORE the json/urlencoded parsers so they don't consume the stream.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), handleStripeWebhook);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public'), { extensions: ['html'] }));

// Master dashboard SPA (built into dashboard/dist by the deploy build step).
// Static assets first, then a catch-all so client-side routes return index.html.
const dashDist = path.join(process.cwd(), 'dashboard', 'dist');
app.use('/app', express.static(dashDist, {
  setHeaders: (res, filePath) => {
    // index.html must always revalidate so new asset hashes are picked up
    // immediately; hashed assets are content-addressed → cache forever.
    if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    else if (filePath.includes('/assets/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  },
}));
// SPA fallback (Express 5 needs a regex, not a bare '*'). Static files above are
// served first; only non-file /app routes fall through to index.html.
app.get(/^\/app(\/.*)?$/, (_req, res) =>
  res.sendFile(path.join(dashDist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));

app.use(requestLogger);

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// DB diagnostic — reports whether Supabase env vars are present and whether a
// trivial query succeeds. Safe to expose: returns no secrets, only presence flags.
app.get('/health/db', async (_req, res) => {
  // Public endpoint: presence booleans only — no project identifiers, no raw
  // driver error messages (those are logged server-side instead).
  const present = {
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_KEY: Boolean(process.env.SUPABASE_SERVICE_KEY),
    DEFAULT_CLINIC_ID: Boolean(process.env.DEFAULT_CLINIC_ID),
    AI_PROVIDER: process.env.AI_PROVIDER ?? null,
  };
  try {
    const { error } = await supabase.from('clinics').select('id').limit(1);
    if (error) {
      console.error('[health/db] query error', error.message);
      return res.status(500).json({ ok: false, present });
    }
    res.json({ ok: true, present });
  } catch (e: any) {
    console.error('[health/db] threw', e?.message ?? e);
    res.status(500).json({ ok: false, present });
  }
});

// Rate limiters (defence-in-depth; webhooks are also signature-gated). Generous
// for Twilio webhooks (shared source IPs), tighter for the agent tools endpoint.
const webhookLimiter = rateLimit({ name: 'webhook', windowMs: 60_000, max: Number(process.env.RL_WEBHOOK_MAX ?? 300) });
const toolsLimiter = rateLimit({ name: 'tools', windowMs: 60_000, max: Number(process.env.RL_TOOLS_MAX ?? 60) });

// WhatsApp (signature-validated)
app.post('/webhooks/whatsapp', webhookLimiter, validateTwilioWebhook, handleInboundWhatsApp);

// Inbound SMS — same brain as WhatsApp (handler reads From/Body/MessageSid and
// replies via TwiML, which works for SMS too). Point your Twilio number's
// Messaging webhook here when running MESSAGING_CHANNEL=sms.
app.post('/webhooks/sms', webhookLimiter, validateTwilioWebhook, handleInboundWhatsApp);

// Voice (signature-validated)
app.post('/webhooks/voice/inbound', webhookLimiter, validateTwilioWebhook, handleInboundCall);
app.post('/webhooks/voice/gather', webhookLimiter, validateTwilioWebhook, handleVoiceGather);
app.post('/webhooks/voice/status', webhookLimiter, validateTwilioWebhook, handleCallStatus);

// ElevenLabs agent server tools (booking actions during a voice call)
app.post('/tools/:tool', toolsLimiter, handleAgentTool);

// Self-serve clinic onboarding (form at /onboard.html; submission token-gated)
app.post('/onboard', webhookLimiter, handleOnboard);

// Digital patient intake form (signed per-patient link)
app.get('/intake', webhookLimiter, renderIntakeForm);
app.post('/intake', webhookLimiter, handleIntakeSubmit);

// Invoice chasing (PaidUp): bulk CSV import + operator list. Token-gated.
app.post('/invoices/import', webhookLimiter, handleInvoiceImport);
app.get('/invoices', webhookLimiter, handleInvoiceList);
app.get('/invoices/source-preview', webhookLimiter, handleSourcePreview); // read-only: what the connected source exposes

// Dashboard API (v1) — SPA talks to these; all behind Supabase-Auth + clinic scope.
app.get('/api/me', requireApiAuth, handleMe);
app.get('/api/today', requireApiAuth, handleToday);
app.get('/api/invoices', requireApiAuth, handleInvoices);
app.get('/api/invoices/:id', requireApiAuth, handleInvoiceDetail);
app.get('/api/bookings', requireApiAuth, handleBookings);
app.post('/api/bookings', requireApiAuth, handleCreateBooking);
app.post('/api/bookings/:id/cancel', requireApiAuth, handleCancelBooking);
app.get('/api/waitlist', requireApiAuth, handleWaitlist);
app.post('/api/waitlist', requireApiAuth, handleAddWaitlist);
app.post('/api/waitlist/:id/move', requireApiAuth, handleMoveWaitlist);
app.post('/api/waitlist/:id/book', requireApiAuth, handleBookWaitlist);
app.delete('/api/waitlist/:id', requireApiAuth, handleRemoveWaitlist);
app.get('/api/conversations', requireApiAuth, handleConversations);
app.get('/api/conversations/:id', requireApiAuth, handleConversationDetail);
app.get('/api/insights', requireApiAuth, handleInsights);
app.get('/api/customers', requireApiAuth, handleCustomers);
app.get('/api/customers/:id', requireApiAuth, handleCustomerProfile);
app.patch('/api/customers/:id', requireApiAuth, handleUpdateCustomer);
app.get('/api/packages', requireApiAuth, handleListPackages);
app.post('/api/packages', requireApiAuth, handleCreatePackage);
app.get('/api/memberships', requireApiAuth, handleListMemberships);
app.post('/api/memberships', requireApiAuth, handleCreateMembership);
app.post('/api/memberships/:id/cancel', requireApiAuth, handleCancelMembership);
app.get('/api/settings', requireApiAuth, handleSettings);
app.post('/api/settings', requireApiAuth, handleUpdateSettings);
app.get('/api/calendar/test', requireApiAuth, handleTestCalendar);
// Operator dashboard (platform admins only — sees ALL clinics)
app.get('/api/admin/clients', requirePlatformAdmin, handleAdminClients);
app.get('/api/connect/:provider/start', requireApiAuth, handleConnectStartAuthed);
app.post('/api/connect/gsheet', requireApiAuth, handleConnectSheetAuthed);
app.post('/api/connect/payment', requireApiAuth, handleConnectPayment);
app.post('/api/connect/email-inbox', requireApiAuth, handleConnectEmailInbox);
app.get('/api/team-ops', requireApiAuth, handleTeamOps);
app.post('/api/team-ops/staff', requireApiAuth, handleAddStaff);
app.delete('/api/team-ops/staff/:id', requireApiAuth, handleRemoveStaff);
app.post('/api/team-ops/leave/:id', requireApiAuth, handleDecideLeave);
app.get('/api/tasks', requireApiAuth, handleTasks);
app.post('/api/tasks', requireApiAuth, handleAddTask);
app.post('/api/tasks/:id/complete', requireApiAuth, handleCompleteTask);
app.delete('/api/tasks/:id', requireApiAuth, handleDeleteTask);
app.post('/api/expenses', requireApiAuth, handleAddExpense);
app.get('/api/team', requireApiAuth, handleTeam);
app.post('/api/team/invite', requireApiAuth, handleTeamInvite);
app.post('/api/team/:userId/role', requireApiAuth, handleTeamRole);
app.delete('/api/team/:userId', requireApiAuth, handleTeamRemove);
app.post('/api/assistant', requireApiAuth, handleAssistant);
app.post('/api/onboarding/complete', requireApiAuth, handleCompleteOnboarding);
app.post('/api/onboarding/whatsapp', requireApiAuth, handleSubmitWhatsApp);
// Phase 3 controls (write actions)
app.post('/api/chasing', requireApiAuth, handleSetChasing);
app.post('/api/invoices/:id/action', requireApiAuth, handleInvoiceActionWrite);
app.post('/api/escalations/:id/resolve', requireApiAuth, handleResolveEscalation);

// Payment links — customers pay an overdue invoice from the chase message.
app.get('/pay/success', handlePaySuccess);
app.get('/pay/cancel', handlePayCancel);
app.get('/pay/stripe/return', handleStripeReturn);
app.get('/pay/paystack/return', handlePaystackReturn);
app.get('/pay/paypal/return', handlePaypalReturn);
app.get('/membership/:id/start', handleMembershipStart);
app.get('/membership/:id/return', handleMembershipReturn);
app.get('/pay/:invoiceId', handlePay);
app.post('/webhooks/payfast', webhookLimiter, handlePayfastNotify);

// Invoice sources — connect an accounting tool so invoices auto-load.
app.post('/connect/gsheet', webhookLimiter, handleConnectSheet);   // Google Sheet (no OAuth)
// White-label email sending domain (Resend) — provision / verify / status
app.post('/connect/email-domain', webhookLimiter, handleEmailDomainSetup);
app.post('/connect/email-domain/verify', webhookLimiter, handleEmailDomainVerify);
app.get('/connect/email-domain', webhookLimiter, handleEmailDomainStatus);
app.get('/connect/:provider', webhookLimiter, handleConnectStart);          // OAuth start
app.get('/connect/:provider/callback', webhookLimiter, handleConnectCallback); // OAuth callback

// Report — gated. Branded HTML "Revenue Recovered" page by default; ?format=text
// returns the plain-text version (used by the CLI/owner summary).
app.get('/report/:clinicId', requireDashboardAuth, async (req, res) => {
  const days = parseInt(qp(req.query.days) ?? '30', 10);
  const clinicId = qp(req.params.clinicId) ?? '';
  if (qp(req.query.format) === 'text') {
    res.type('text/plain').send(await generateReport(clinicId, days));
  } else {
    res.type('text/html').send(await renderReportPage(clinicId, days));
  }
});

// Dashboard (HTML) — gated: exposes patient data
app.get('/dashboard/:clinicId', requireDashboardAuth, async (req, res) => {
  const days = parseInt(qp(req.query.days) ?? '30', 10);
  const html = await renderDashboard(qp(req.params.clinicId) ?? '', days);
  res.type('text/html').send(html);
});

// Convenience redirect for default clinic (preserves ?token= so auth carries through)
app.get('/dashboard', (req, res) => {
  if (config.defaultClinicId) {
    const t = qp(req.query.token);
    const token = t ? `?token=${encodeURIComponent(t)}` : '';
    return res.redirect(`/dashboard/${config.defaultClinicId}${token}`);
  }
  res.status(400).send('Set DEFAULT_CLINIC_ID in .env');
});

// Error-handling middleware must be mounted AFTER all routes. In Express 5,
// rejected async route handlers are forwarded here automatically.
attachErrorHandler(app);

const PORT = parseInt(process.env.PORT ?? '3001', 10);
// Use an explicit HTTP server so the ConversationRelay WebSocket can share the port.
const server = http.createServer(app);
// Attach ONLY the WebSocket endpoint the active voice mode needs. Binding two
// `ws` servers to the same HTTP server via { server, path } makes them fight over
// the 'upgrade' event — the non-matching one aborts the handshake with HTTP 400,
// which dropped media-stream calls instantly. One mode → one WS server.
if (config.voice.mode === 'conversationrelay') {
  attachVoiceRelay(server); // /ws/voice (ConversationRelay)
} else if (config.voice.mode === 'mediastream') {
  attachMediaStream(server); // /ws/media (custom Azure / Deepgram+ElevenLabs pipeline)
}
server.listen(PORT, () => {
  console.log(`Remi listening on :${config.port} (model: ${config.model}, voice: ${config.voice.mode})`);
  void initMonitoring();
  // Run the reminder scheduler in-process unless explicitly disabled. For a
  // single web instance this avoids needing a separate worker. When scaling to
  // multiple instances, set RUN_SCHEDULER=false here and run one dedicated worker.
  if (process.env.RUN_SCHEDULER !== 'false') startScheduler();
});
