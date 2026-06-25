import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabase';
import { Login } from './components/Login';
import { Shell } from './components/Shell';
import { InstallBanner } from './components/InstallBanner';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!ready) return <div className="boot">Loading…</div>;
  return (
    <>
      <InstallBanner />
      {session ? <Shell onSignOut={() => supabase.auth.signOut()} /> : <Login />}
    </>
  );
}
