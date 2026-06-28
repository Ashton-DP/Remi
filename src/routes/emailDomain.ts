import type { Request, Response } from 'express';
import { config } from '../config';
import { safeEqual, qp } from '../lib/dashboardAuth';
import { validateDomain, emailOnDomain, createDomain, getDomain, verifyDomain } from '../lib/resendDomains';
import { getClinic, setClinicEmailDomain, updateClinicEmailDomainStatus } from '../db';

function authed(req: Request): boolean {
  const tok = config.chase.importToken;
  if (!tok) return false;
  // Prefer header/body; query (?token=) stays for backward compat but leaks into
  // access logs — the X-Chase-Token header is the recommended way to pass it.
  const given = String(req.get('X-Chase-Token') ?? (req.body && req.body.token) ?? qp(req.query.token) ?? '');
  return safeEqual(given, tok);
}

/** POST /connect/email-domain { clinic_id, domain, from_email, reply_to?, token }
 *  Provisions the clinic's sending domain in Resend and returns the DNS records
 *  to add. Until verified, chasing still sends send-on-behalf (clinic name +
 *  reply-to on Remi's domain); once verified it auto-upgrades to the clinic's domain. */
export async function handleEmailDomainSetup(req: Request, res: Response) {
  if (!config.email.resendApiKey) return res.status(503).json({ error: 'Email not configured — set RESEND_API_KEY first.' });
  if (!authed(req)) return res.status(403).json({ error: 'Invalid token.' });

  const clinicId = String(req.body?.clinic_id ?? '').trim();
  const domain = validateDomain(String(req.body?.domain ?? ''));
  const fromEmail = String(req.body?.from_email ?? '').trim().toLowerCase();
  const replyTo = String(req.body?.reply_to ?? '').trim() || fromEmail;
  if (!clinicId || !domain) return res.status(400).json({ error: 'clinic_id and a valid domain are required.' });
  if (!fromEmail.includes('@')) return res.status(400).json({ error: `from_email is required (e.g. billing@${domain}).` });
  if (!emailOnDomain(fromEmail, domain)) return res.status(400).json({ error: `from_email must be on ${domain}.` });

  try {
    const d = await createDomain(domain);
    await setClinicEmailDomain(clinicId, { domain, id: d.id, status: 'pending', records: d.records, fromEmail, replyTo });
    return res.json({
      status: 'pending',
      domain,
      dns_records: d.records,
      note: 'Add these DNS records to the domain, then POST /connect/email-domain/verify. Remi also auto-checks pending domains daily.',
    });
  } catch (e: any) {
    return res.status(502).json({ error: e?.message ?? String(e) });
  }
}

/** POST /connect/email-domain/verify { clinic_id, token } — check DNS + flip to live. */
export async function handleEmailDomainVerify(req: Request, res: Response) {
  if (!authed(req)) return res.status(403).json({ error: 'Invalid token.' });
  const clinicId = String((req.body?.clinic_id) ?? qp(req.query.clinic_id) ?? '').trim();
  if (!clinicId) return res.status(400).json({ error: 'clinic_id required.' });
  const clinic = await getClinic(clinicId);
  if (!clinic?.email_domain_id) return res.status(400).json({ error: 'No email domain set up for this clinic.' });

  try {
    await verifyDomain(clinic.email_domain_id);
    const d = await getDomain(clinic.email_domain_id);
    const status = d.status === 'verified' ? 'verified' : 'pending';
    await updateClinicEmailDomainStatus(clinicId, status, d.records);
    return res.json({
      status,
      verified: status === 'verified',
      from_email: status === 'verified' ? clinic.chase_from_email : undefined,
      dns_records: d.records,
    });
  } catch (e: any) {
    return res.status(502).json({ error: e?.message ?? String(e) });
  }
}

/** GET /connect/email-domain?clinic_id=&token= — current status + records. */
export async function handleEmailDomainStatus(req: Request, res: Response) {
  if (!authed(req)) return res.status(403).json({ error: 'Invalid token.' });
  const clinic = await getClinic(qp(req.query.clinic_id) ?? '');
  if (!clinic) return res.status(404).json({ error: 'clinic not found' });
  return res.json({
    domain: clinic.email_domain ?? null,
    status: clinic.email_domain_status ?? 'none',
    from_email: clinic.chase_from_email ?? null,
    reply_to: clinic.chase_reply_to ?? null,
    dns_records: clinic.email_domain_records ?? [],
  });
}
