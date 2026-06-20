import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { config } from './config';
import { handleInboundWhatsApp } from './routes/whatsapp';
import { handleInboundCall, handleVoiceGather, handleCallStatus } from './routes/voice';
import { generateReport } from './report';
import { renderDashboard } from './dashboard';
import { supabase } from './lib/supabase';
import { validateTwilioWebhook } from './lib/twilioWebhook';
import { startScheduler } from './scheduler';
import { attachVoiceRelay } from './routes/voiceRelay';
import { attachMediaStream } from './routes/mediaStream';
import { handleAgentTool } from './routes/agentTools';
import { handleStripeWebhook } from './routes/stripeWebhook';

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

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// DB diagnostic — reports whether Supabase env vars are present and whether a
// trivial query succeeds. Safe to expose: returns no secrets, only presence flags.
app.get('/health/db', async (_req, res) => {
  const present = {
    SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
    SUPABASE_SERVICE_KEY: Boolean(process.env.SUPABASE_SERVICE_KEY),
    DEFAULT_CLINIC_ID: Boolean(process.env.DEFAULT_CLINIC_ID),
    AI_PROVIDER: process.env.AI_PROVIDER ?? null,
    urlHost: (process.env.SUPABASE_URL ?? '').replace(/^https?:\/\//, '').split('.')[0] || null,
  };
  try {
    const { error } = await supabase.from('clinics').select('id').limit(1);
    if (error) return res.status(500).json({ ok: false, present, queryError: error.message });
    res.json({ ok: true, present });
  } catch (e: any) {
    res.status(500).json({ ok: false, present, error: e?.message ?? String(e) });
  }
});

// WhatsApp (signature-validated)
app.post('/webhooks/whatsapp', validateTwilioWebhook, handleInboundWhatsApp);

// Voice (signature-validated)
app.post('/webhooks/voice/inbound', validateTwilioWebhook, handleInboundCall);
app.post('/webhooks/voice/gather', validateTwilioWebhook, handleVoiceGather);
app.post('/webhooks/voice/status', validateTwilioWebhook, handleCallStatus);

// ElevenLabs agent server tools (booking actions during a voice call)
app.post('/tools/:tool', handleAgentTool);

// Report (text)
app.get('/report/:clinicId', async (req, res) => {
  const days = parseInt((req.query.days as string) ?? '30', 10);
  const report = await generateReport(req.params.clinicId, days);
  res.type('text/plain').send(report);
});

// Dashboard (HTML)
app.get('/dashboard/:clinicId', async (req, res) => {
  const days = parseInt((req.query.days as string) ?? '30', 10);
  const html = await renderDashboard(req.params.clinicId, days);
  res.type('text/html').send(html);
});

// Convenience redirect for default clinic
app.get('/dashboard', (_req, res) => {
  if (config.defaultClinicId) return res.redirect(`/dashboard/${config.defaultClinicId}`);
  res.status(400).send('Set DEFAULT_CLINIC_ID in .env');
});

const PORT = parseInt(process.env.PORT ?? '3001', 10);
// Use an explicit HTTP server so the ConversationRelay WebSocket can share the port.
const server = http.createServer(app);
attachVoiceRelay(server); // mounts the /ws/voice WebSocket endpoint (ConversationRelay)
attachMediaStream(server); // mounts the /ws/media WebSocket endpoint (custom pipeline)
server.listen(PORT, () => {
  console.log(`Remi listening on :${config.port} (model: ${config.model}, voice: ${config.voice.mode})`);
  // Run the reminder scheduler in-process unless explicitly disabled. For a
  // single web instance this avoids needing a separate worker. When scaling to
  // multiple instances, set RUN_SCHEDULER=false here and run one dedicated worker.
  if (process.env.RUN_SCHEDULER !== 'false') startScheduler();
});
