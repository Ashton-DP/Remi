import express from 'express';
import { config } from './config';
import { handleInboundWhatsApp } from './routes/whatsapp';
import { generateReport } from './report';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/webhooks/whatsapp', handleInboundWhatsApp);

app.get('/report/:clinicId', async (req, res) => {
  const days = parseInt((req.query.days as string) ?? '30', 10);
  const report = await generateReport(req.params.clinicId, days);
  res.type('text/plain').send(report);
});

app.listen(config.port, () => {
  console.log(`Remi listening on :${config.port} (model: ${config.model})`);
});
