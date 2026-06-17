import express from 'express';
import { config } from './config';
import { handleInboundWhatsApp } from './routes/whatsapp';

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));
app.post('/webhooks/whatsapp', handleInboundWhatsApp);

app.listen(config.port, () => {
  console.log(`Remi listening on :${config.port} (model: ${config.model})`);
});
