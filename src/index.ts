import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { config } from './config';
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
import { handlePay, handlePaySuccess, handlePayCancel, handlePayfastNotify, handleStripeReturn, handlePaypalReturn } from './routes/pay';
import { requireApiAuth } from './lib/apiAuth';
import {
  handleMe, handleToday, handleInvoices, handleInvoiceDetail, handleBookings,
  handleConversations, handleConversationDetail, handleInsights, handleAssistant,
  handleCustomers, handleSetChasing, handleInvoiceActionWrite, handleResolveEscalation,
  handleSettings, handleUpdateSettings,
  handleConnectStartAuthed, handleConnectSheetAuthed, handleConnectPayment,
} from './routes/api';

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
app.get('/api/conversations', requireApiAuth, handleConversations);
app.get('/api/conversations/:id', requireApiAuth, handleConversationDetail);
app.get('/api/insights', requireApiAuth, handleInsights);
app.get('/api/customers', requireApiAuth, handleCustomers);
app.get('/api/settings', requireApiAuth, handleSettings);
app.post('/api/settings', requireApiAuth, handleUpdateSettings);
app.get('/api/connect/:provider/start', requireApiAuth, handleConnectStartAuthed);
app.post('/api/connect/gsheet', requireApiAuth, handleConnectSheetAuthed);
app.post('/api/connect/payment', requireApiAuth, handleConnectPayment);
app.post('/api/assistant', requireApiAuth, handleAssistant);
// Phase 3 controls (write actions)
app.post('/api/chasing', requireApiAuth, handleSetChasing);
app.post('/api/invoices/:id/action', requireApiAuth, handleInvoiceActionWrite);
app.post('/api/escalations/:id/resolve', requireApiAuth, handleResolveEscalation);

// Payment links — customers pay an overdue invoice from the chase message.
app.get('/pay/success', handlePaySuccess);
app.get('/pay/cancel', handlePayCancel);
app.get('/pay/stripe/return', handleStripeReturn);
app.get('/pay/paypal/return', handlePaypalReturn);
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
attachVoiceRelay(server); // mounts the /ws/voice WebSocket endpoint (ConversationRelay)
attachMediaStream(server); // mounts the /ws/media WebSocket endpoint (custom pipeline)
server.listen(PORT, () => {
  console.log(`Remi listening on :${config.port} (model: ${config.model}, voice: ${config.voice.mode})`);
  void initMonitoring();
  // Run the reminder scheduler in-process unless explicitly disabled. For a
  // single web instance this avoids needing a separate worker. When scaling to
  // multiple instances, set RUN_SCHEDULER=false here and run one dedicated worker.
  if (process.env.RUN_SCHEDULER !== 'false') startScheduler();
});
