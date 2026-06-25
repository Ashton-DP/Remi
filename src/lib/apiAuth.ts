/**
 * Dashboard API auth. The SPA logs in via Supabase Auth and sends the resulting
 * JWT as a Bearer token; this middleware validates it, resolves the user's clinic
 * + role, and scopes the request. Fail-closed.
 */
import type { Request, Response, NextFunction } from 'express';
import { supabase } from './supabase';
import { getUserClinic, isPlatformAdmin } from '../db';

export type ApiAuth = { userId: string; email: string | null; clinicId: string; role: string };

/** Pull the bearer token from an Authorization header. Pure. */
export function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

/** Express middleware: require a valid Supabase session with clinic access. */
export async function requireApiAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const token = extractBearer(req.get('Authorization'));
    if (!token) return res.status(401).json({ error: 'Not authenticated' });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired session' });

    const membership = await getUserClinic(data.user.id);
    if (!membership) return res.status(403).json({ error: 'No clinic access for this account' });

    (req as any).auth = {
      userId: data.user.id,
      email: data.user.email ?? null,
      clinicId: membership.clinic_id,
      role: membership.role,
    } satisfies ApiAuth;
    next();
  } catch (e: any) {
    console.error('[apiAuth]', e?.message ?? e);
    return res.status(401).json({ error: 'Auth check failed' });
  }
}

/** Read the resolved auth off the request (after requireApiAuth). */
export function getAuth(req: Request): ApiAuth {
  return (req as any).auth as ApiAuth;
}

/** Express middleware: require a valid session that is a platform admin (sees all
 *  clinics). Not clinic-scoped — for the operator dashboard. Fail-closed. */
export async function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const token = extractBearer(req.get('Authorization'));
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'Invalid or expired session' });
    if (!(await isPlatformAdmin(data.user.id))) return res.status(403).json({ error: 'Not a platform admin' });
    (req as any).adminUser = { userId: data.user.id, email: data.user.email ?? null };
    next();
  } catch (e: any) {
    console.error('[apiAuth:admin]', e?.message ?? e);
    return res.status(401).json({ error: 'Auth check failed' });
  }
}

/** Gate an action to owner/admin (vs read-only staff). Pure. */
export function roleAtLeast(role: string, min: 'staff' | 'admin' | 'owner'): boolean {
  const rank: Record<string, number> = { staff: 1, admin: 2, owner: 3 };
  return (rank[role] ?? 0) >= rank[min];
}
