import express from 'express';
import path from 'node:path';
import { config } from './config';
import { handleInboundWhatsApp } from './routes/whatsapp';
import { handleInboundCall, handleVoiceGather, handleCallStatus } from './routes/voice';
import { generateReport } from './report';
import { renderDashboard } from './dashboard';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

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
