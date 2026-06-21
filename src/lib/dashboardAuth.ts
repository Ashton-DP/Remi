import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { config } from '../config';
import { getClinic } from '../db';

// Gate for /dashboard and /report — these expose patient data, so they must not
// be world-readable. FAIL-CLOSED: with no DASHBOARD_TOKEN set, access is denied.
//
// Access is granted by a token, supplied as `?token=…` (which then sets an
// HttpOnly cookie so later navigation works) or via that cookie. A request is
// allowed if the token matches EITHER the master DASHBOARD_TOKEN, or the
// requested clinic's own `dashboard_token` (a scoped link you can hand a clinic).

const COOKIE = 'remi_dash';

/** Coerce an Express query value (string | string[] | undefined) to a string. */
export function qp(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

/** Constant-time string compare that won't throw on length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function cookieToken(req: Request): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function deny(res: Response, msg: string, code = 401): void {
  res
    .status(code)
    .type('text/html')
    .send(
      `<!DOCTYPE html><meta charset="utf-8"><body style="font-family:system-ui;max-width:520px;margin:80px auto;color:#334155">
       <h2>🔒 Access required</h2><p>${msg}</p></body>`,
    );
}

export async function requireDashboardAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const master = config.dashboard.token;

  // Fail closed: an unconfigured dashboard stays shut rather than open.
  if (!master) {
    deny(res, 'The dashboard is disabled. Set <code>DASHBOARD_TOKEN</code> to enable it.', 503);
    return;
  }

  const supplied = qp(req.query.token) || cookieToken(req) || '';
  if (!supplied) {
    deny(res, 'Append <code>?token=…</code> to the URL to view this dashboard.');
    return;
  }

  let ok = safeEqual(supplied, master);

  // Per-clinic scoped token (lets a clinic see only its own dashboard).
  const clinicId = qp(req.params.clinicId);
  if (!ok && clinicId) {
    const clinic = await getClinic(clinicId).catch(() => null);
    if (clinic?.dashboard_token) ok = safeEqual(supplied, String(clinic.dashboard_token));
  }

  if (!ok) {
    deny(res, 'Invalid access token.', 403);
    return;
  }

  // Valid via query → persist as an HttpOnly cookie so subsequent links work.
  if (req.query.token) {
    res.cookie(COOKIE, supplied, {
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }

  next();
}
