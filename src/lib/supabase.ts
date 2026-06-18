import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config';

// Lazy singleton: the Supabase client is only constructed on first use, not at
// import time. createClient() throws synchronously if the URL is empty, so
// constructing at module load would crash the entire process (and take down the
// static landing page + /health) whenever SUPABASE_URL is missing. Deferring it
// means the web server still boots; only DB-backed routes fail, with a clear error.
let _client: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (_client) return _client;
  if (!config.supabaseUrl || !config.supabaseServiceKey) {
    throw new Error(
      'Supabase is not configured: set SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables.',
    );
  }
  _client = createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false },
  });
  return _client;
}

// Proxy preserves the existing `supabase.from(...)` call sites unchanged while
// deferring construction until the first property access.
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
