import type { Request, Response } from 'express';
import { verifyIntakeToken } from '../lib/intake';
import { getClientById, saveIntake, getClinic } from '../db';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const shell = (title: string, inner: string) =>
  `<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <body style="font-family:-apple-system,Segoe UI,sans-serif;background:#f6f7fb;color:#1e2233;max-width:560px;margin:0 auto;padding:32px 18px">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
    <div style="width:32px;height:32px;border-radius:8px;background:linear-gradient(135deg,#6c63ff,#4ecdc4);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800">R</div>
    <b>${title}</b></div>${inner}</body>`;

const field = (label: string, name: string, type = 'text', required = false) =>
  `<label style="display:block;font-weight:600;font-size:14px;margin:16px 0 6px">${label}</label>
   <input name="${name}" type="${type}" ${required ? 'required' : ''} style="width:100%;border:1px solid #e6e8f0;border-radius:10px;padding:11px 13px;font-size:14px">`;

const area = (label: string, name: string) =>
  `<label style="display:block;font-weight:600;font-size:14px;margin:16px 0 6px">${label}</label>
   <textarea name="${name}" style="width:100%;min-height:80px;border:1px solid #e6e8f0;border-radius:10px;padding:11px 13px;font-size:14px;font-family:inherit"></textarea>`;

/** GET /intake?c=<clientId>&t=<token> — render the patient intake form. */
export async function renderIntakeForm(req: Request, res: Response) {
  const clientId = String(req.query.c ?? '');
  const token = String(req.query.t ?? '');
  if (!clientId || !verifyIntakeToken(clientId, token)) {
    return res.status(403).type('text/html').send(shell('Invalid link', '<p>This intake link is invalid or expired.</p>'));
  }
  const client = await getClientById(clientId);
  if (!client) return res.status(404).type('text/html').send(shell('Not found', '<p>We couldn’t find your record.</p>'));
  if (client.intake_submitted_at) {
    return res.type('text/html').send(shell('All done ✅', '<p>Thanks — we’ve already got your details. See you at your appointment!</p>'));
  }
  const clinic = await getClinic(client.clinic_id);
  const inner = `
    <p style="color:#64748b;font-size:14px;margin:4px 0 20px">Please confirm a few details before your visit to ${esc(clinic?.name ?? 'the clinic')}. Takes 2 minutes.</p>
    <form method="POST" action="/intake" style="background:#fff;border:1px solid #e6e8f0;border-radius:16px;padding:22px">
      <input type="hidden" name="c" value="${esc(clientId)}"><input type="hidden" name="t" value="${esc(token)}">
      ${field('Full name', 'full_name', 'text', true)}
      ${field('Date of birth', 'dob', 'date')}
      ${field('Email', 'email', 'email')}
      ${area('Medical conditions / allergies', 'conditions')}
      ${area('Current medications', 'medications')}
      ${area('Reason for visit / what you’d like to discuss', 'reason')}
      <label style="display:flex;gap:8px;align-items:flex-start;margin:18px 0 6px;font-size:13px;color:#475569">
        <input type="checkbox" name="consent" value="yes" required style="margin-top:3px">
        I consent to the clinic processing this information to provide my care.</label>
      <button type="submit" style="margin-top:18px;background:#6c63ff;color:#fff;border:0;border-radius:10px;padding:13px 26px;font-size:15px;font-weight:600;cursor:pointer">Submit</button>
    </form>`;
  res.type('text/html').send(shell('Patient intake form', inner));
}

/** POST /intake — save the submitted intake against the client. */
export async function handleIntakeSubmit(req: Request, res: Response) {
  const clientId = String(req.body.c ?? '');
  const token = String(req.body.t ?? '');
  if (!clientId || !verifyIntakeToken(clientId, token)) {
    return res.status(403).type('text/html').send(shell('Invalid link', '<p>This intake link is invalid.</p>'));
  }
  try {
    await saveIntake(clientId, {
      full_name: String(req.body.full_name ?? '').slice(0, 200),
      dob: String(req.body.dob ?? '').slice(0, 40),
      email: String(req.body.email ?? '').slice(0, 200),
      conditions: String(req.body.conditions ?? '').slice(0, 2000),
      medications: String(req.body.medications ?? '').slice(0, 2000),
      reason: String(req.body.reason ?? '').slice(0, 2000),
      consent: req.body.consent === 'yes',
    });
    return res.type('text/html').send(shell('Thank you ✅', '<p>Your details are in — see you at your appointment!</p>'));
  } catch (e: any) {
    console.error('[intake submit]', e);
    return res.status(500).type('text/html').send(shell('Something went wrong', `<p>${esc(e.message)}</p>`));
  }
}
