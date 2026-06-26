import { useState } from 'react';
import { supabase } from '../lib/supabase';

const params = new URLSearchParams(window.location.search);
const isWelcome = params.get('welcome') === '1';
const isMagicLink = params.get('type') === 'magiclink' || params.get('type') === 'recovery';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [mode, setMode] = useState<'login' | 'reset'>('login');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(''); setBusy(true);
    if (mode === 'reset') {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/app?type=recovery`,
      });
      if (error) setErr(error.message);
      else setResetSent(true);
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setErr(error.message);
    }
    setBusy(false);
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <div className="logo-dot">R</div>
          <div>
            <div className="brand-name">Remi</div>
            <div className="brand-sub">Command Centre</div>
          </div>
        </div>

        {isWelcome && (
          <div className="login-banner welcome">
            <strong>Welcome to Remi!</strong> We've emailed your login details — check your inbox (and spam folder) then sign in below.
          </div>
        )}

        {isMagicLink && (
          <div className="login-banner info">
            Set a new password below to finish activating your account.
          </div>
        )}

        {resetSent ? (
          <div className="login-banner welcome">
            Password reset email sent — check your inbox.
          </div>
        ) : (
          <>
            <h1>{mode === 'reset' ? 'Reset password' : 'Sign in'}</h1>
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
            {mode === 'login' && (
              <>
                <label>Password</label>
                <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
              </>
            )}
            {err && <p className="error">{err}</p>}
            <button type="submit" disabled={busy}>{busy ? '…' : mode === 'reset' ? 'Send reset email' : 'Sign in'}</button>
            <p className="hint">
              {mode === 'login'
                ? <><span className="link" onClick={() => { setMode('reset'); setErr(''); }}>Forgot password?</span> · Need help? Contact your Remi setup team.</>
                : <><span className="link" onClick={() => { setMode('login'); setErr(''); }}>Back to sign in</span></>}
            </p>
            <p className="hint" style={{ marginTop: 12, fontSize: 12 }}>
              By signing in you agree to our{' '}
              <a href="https://remireception.com/terms" target="_blank" rel="noreferrer">Terms of Service</a>
              {' '}and{' '}
              <a href="https://remireception.com/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
            </p>
          </>
        )}
      </form>
    </div>
  );
}
