import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import { config } from '../config';
import { createClinic } from '../db';
import { safeEqual } from '../lib/dashboardAuth';

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** Services textarea: one per line "Name | duration_min | price_zar". */
export function parseServices(text: string): any[] {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [service, dur, price, prep] = line.split('|').map((p) => p.trim());
      const row: any = {
        service: service || 'Service',
        duration_min: parseInt(dur, 10) || 30,
        price_zar: parseInt(price, 10) || 0,
      };
      if (prep) row.prep = prep; // optional treatment prep instructions
      return row;
    });
}

/** Hours textarea: one per line "mon 09:00-17:00" (omit a day = closed). */
export function parseHours(text: string): Record<string, [string, string][]> {
  const out: Record<string, [string, string][]> = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().toLowerCase().match(/^(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
    if (m && WEEKDAYS.includes(m[1])) out[m[1]] = [[m[2], m[3]]];
  }
  return out;
}

/** FAQs textarea: one per line "Question | Answer". */
export function parseFaqs(text: string): any[] {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const [q, a] = line.split('|').map((p) => p.trim());
      return { q: q || '', a: a || '' };
    })
    .filter((f) => f.q);
}

const page = (title: string, bodyHtml: string) =>
  `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <body style="font-family:-apple-system,Segoe UI,sans-serif;max-width:640px;margin:60px auto;padding:0 20px;color:#1e2233">
  <h2>${title}</h2>${bodyHtml}</body>`;

/** POST /onboard — create a clinic from the self-serve form. Token-gated. */
export async function handleOnboard(req: Request, res: Response) {
  if (!config.onboard.token) {
    return res.status(503).type('text/html').send(page('Onboarding disabled', '<p>Set <code>ONBOARD_TOKEN</code> to enable the onboarding form.</p>'));
  }
  const token = String(req.body.access_token ?? '');
  if (!safeEqual(token, config.onboard.token)) {
    return res.status(403).type('text/html').send(page('Invalid access token', '<p>The access token is incorrect.</p>'));
  }
  const name = String(req.body.name ?? '').trim();
  if (!name) {
    return res.status(400).type('text/html').send(page('Missing clinic name', '<p>Clinic name is required. <a href="/onboard">Go back</a>.</p>'));
  }
  try {
    const dashboardToken = crypto.randomBytes(12).toString('hex');
    const clinic = await createClinic({
      name,
      timezone: String(req.body.timezone || 'Africa/Johannesburg').trim(),
      services_json: parseServices(req.body.services),
      hours_json: parseHours(req.body.hours),
      faq_json: parseFaqs(req.body.faqs),
      owner_summary_phone: String(req.body.owner_phone || '').trim() || undefined,
      escalation_contact: String(req.body.owner_phone || '').trim() || undefined,
      knowledge: String(req.body.knowledge || '').trim() || undefined,
      dashboard_token: dashboardToken,
    });
    const link = `/dashboard/${clinic.id}?token=${dashboardToken}`;
    return res.type('text/html').send(page('✅ Clinic created',
      `<p><b>${name}</b> is set up.</p>
       <p>Clinic ID: <code>${clinic.id}</code></p>
       <p>Dashboard: <a href="${link}">${link}</a></p>
       <p>Set <code>DEFAULT_CLINIC_ID=${clinic.id}</code> to point the agent at it, and generate its subscription link with <code>createClinicSubscriptionLink.mjs</code>.</p>`));
  } catch (e: any) {
    console.error('[onboard]', e);
    return res.status(500).type('text/html').send(page('Something went wrong', `<p>${e.message}</p>`));
  }
}
