// Applies SQL migrations against your Postgres (Supabase) database.
// Usage:
//   node --env-file=.env scripts/runMigrations.mjs              # runs all db/migrate_*.sql (sorted)
//   node --env-file=.env scripts/runMigrations.mjs migrate_plan # runs just db/migrate_plan.sql
//
// Needs a direct Postgres connection string in .env as DATABASE_URL (or
// SUPABASE_DB_URL). Get it from Supabase → Project Settings → Database →
// "Connection string" → URI (it includes the DB password). The migration files
// use IF NOT EXISTS, so re-running is safe.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const conn = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
if (!conn) {
  console.error('Missing DATABASE_URL (or SUPABASE_DB_URL) in .env — paste your Supabase Postgres URI there.');
  process.exit(1);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const migDir = path.join(here, '..', 'db');

// Which files to run: explicit args (with or without .sql / migrate_ prefix), else all migrate_*.sql.
const args = process.argv.slice(2);
let files;
if (args.length) {
  files = args.map((a) => {
    let f = a.endsWith('.sql') ? a : `${a}.sql`;
    if (!f.startsWith('migrate_') && !fs.existsSync(path.join(migDir, f))) f = `migrate_${f}`;
    return f;
  });
} else {
  files = fs.readdirSync(migDir).filter((f) => f.startsWith('migrate_') && f.endsWith('.sql')).sort();
}

const client = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });

async function main() {
  await client.connect();
  const host = (() => { try { return new URL(conn).host; } catch { return 'db'; } })();
  console.log(`Connected to ${host}\n`);
  for (const f of files) {
    const full = path.join(migDir, f);
    if (!fs.existsSync(full)) { console.error(`⚠️  skip ${f} — not found`); continue; }
    const sql = fs.readFileSync(full, 'utf8');
    process.stdout.write(`→ ${f} … `);
    try {
      await client.query(sql);
      console.log('ok');
    } catch (e) {
      console.log('FAILED');
      console.error(`   ${e.message}`);
    }
  }
  console.log('\nDone.');
}
main()
  .catch((e) => { console.error('❌', e.message); process.exitCode = 1; })
  .finally(() => client.end());
