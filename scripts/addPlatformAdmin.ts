/**
 * Grant a Supabase auth user platform-admin (operator god-view across all clinics).
 * Usage: tsx scripts/addPlatformAdmin.ts <email>
 * Requires the platform_admins table (db/migrate_platform_admins.sql).
 */
import { supabase } from '../src/lib/supabase';
import { addPlatformAdmin } from '../src/db';

const email = process.argv[2];
if (!email) { console.error('usage: tsx scripts/addPlatformAdmin.ts <email>'); process.exit(1); }

(async () => {
  // Find the auth user by email (paginated).
  let userId = '';
  for (let page = 1; page <= 20 && !userId; page++) {
    const { data } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    const u = (data?.users ?? []).find((x: any) => (x.email || '').toLowerCase() === email.toLowerCase());
    if (u) userId = u.id;
    if ((data?.users ?? []).length < 200) break;
  }
  if (!userId) { console.error(`No auth user found for ${email}. Sign in once at /app first, then re-run.`); process.exit(1); }

  await addPlatformAdmin(userId);
  console.log(`✓ ${email} (${userId}) is now a platform admin — they'll see the Operator view on next sign-in.`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
