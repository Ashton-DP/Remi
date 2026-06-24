/**
 * Create (or reset) a dashboard login and link it to a clinic.
 * Usage: tsx scripts/createDashboardUser.ts <email> <clinicId> [role]
 * Writes the generated password to ~/Desktop/remi-login.txt (never to stdout).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { supabase } from '../src/lib/supabase';
import { linkUserToClinic } from '../src/db';

const email = process.argv[2];
const clinicId = process.argv[3] || process.env.DEFAULT_CLINIC_ID || '';
const role = process.argv[4] || 'owner';
if (!email || !clinicId) {
  console.error('usage: tsx scripts/createDashboardUser.ts <email> <clinicId> [role]');
  process.exit(1);
}

const password = crypto.randomBytes(12).toString('base64url'); // ~16 strong chars

(async () => {
  let userId: string;
  const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (error) {
    if (/registered|already|exists/i.test(error.message)) {
      const { data: list } = await supabase.auth.admin.listUsers();
      const u = (list?.users ?? []).find((x: any) => (x.email || '').toLowerCase() === email.toLowerCase());
      if (!u) throw new Error('user exists but could not be located');
      userId = u.id;
      await supabase.auth.admin.updateUserById(userId, { password, email_confirm: true });
      console.log('• user already existed — password reset');
    } else {
      throw error;
    }
  } else {
    userId = data.user!.id;
    console.log('• user created');
  }

  await linkUserToClinic(userId, clinicId, role);
  console.log(`• linked ${email} to clinic ${clinicId} as ${role}`);

  const file = path.join(os.homedir(), 'Desktop', 'remi-login.txt');
  fs.writeFileSync(file,
    `Remi dashboard login\n=====================\n` +
    `URL:      https://www.remireception.com/app\n` +
    `Email:    ${email}\n` +
    `Password: ${password}\n` +
    `Role:     ${role}\nClinic:   ${clinicId}\n\n` +
    `Change your password after first sign-in.\n`);
  console.log(`• credentials written to ${file}`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
