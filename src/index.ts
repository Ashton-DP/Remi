import express from 'express';
import path from 'node:path';
import { config } from './config';
import { handleInboundWhatsApp } from './routes/whatsapp';
import { handleInboundCall, handleVoiceGather, handleCallStatus } from './routes/voice';
import { generateReport } from './report';
import { renderDashboard } from './dashboard';
import { supabase } from './lib/supabase';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

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

// WhatsApp
app.post('/webhooks/whatsapp', handleInboundWhatsApp);

// Voice
app.post('/webhooks/voice/inbound', handleInboundCall);
app.post('/webhooks/voice/gather', handleVoiceGather);
app.post('/webhooks/voice/status', handleCallStatus);

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
app.listen(PORT, () => {
  console.log(`Remi listening on :${config.port} (model: ${config.model})`);
});
