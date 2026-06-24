import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Member = { user_id: string; role: string; email: string | null; you: boolean };
const ROLES = ['owner', 'admin', 'staff'];
const roleHint: Record<string, string> = {
  owner: 'Full access — can manage the team and billing.',
  admin: 'Can take actions (book, chase, resolve) but not manage the team.',
  staff: 'Read-only — can see everything, change nothing.',
};

export function Team() {
  const [rows, setRows] = useState<Member[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ email: '', role: 'staff' });
  const [invited, setInvited] = useState<{ email: string; temp_password?: string } | null>(null);

  function load() {
    api<{ members: Member[]; can_manage: boolean }>('/api/team')
      .then((d) => { setRows(d.members); setCanManage(d.can_manage); })
      .catch((e) => setErr(e.message));
  }
  useEffect(load, []);

  async function invite() {
    if (!form.email.includes('@')) { setErr('Enter a valid email.'); return; }
    setBusy(true); setErr(''); setInvited(null);
    try {
      const r = await api<{ ok: boolean; email: string; temp_password?: string; existing?: boolean }>(
        '/api/team/invite', { method: 'POST', body: JSON.stringify(form) });
      setInvited({ email: r.email, temp_password: r.temp_password });
      setForm({ email: '', role: 'staff' });
      setAdding(false);
      load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function changeRole(m: Member, role: string) {
    setBusy(true); setErr('');
    try { await api(`/api/team/${m.user_id}/role`, { method: 'POST', body: JSON.stringify({ role }) }); load(); }
    catch (e: any) { setErr(e.message); load(); } finally { setBusy(false); }
  }
  async function remove(m: Member) {
    if (!confirm(`Remove ${m.email || 'this member'} from the team? They'll lose access immediately.`)) return;
    setBusy(true); setErr('');
    try { await api(`/api/team/${m.user_id}`, { method: 'DELETE' }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (err && !rows) return <div className="banner error">{err}</div>;
  if (!rows) return <div className="empty">Loading…</div>;

  return (
    <>
      {err && <div className="banner error">{err}</div>}
      {invited && (
        <div className="banner" style={{ background: 'var(--green-bg)', border: '1px solid rgba(52,211,153,.25)', color: '#bbf7d0' }}>
          {invited.temp_password
            ? <>Added <b>{invited.email}</b>. Temporary password: <code style={{ background: 'rgba(0,0,0,.25)', padding: '2px 6px', borderRadius: 5 }}>{invited.temp_password}</code> — share it securely; they should change it on first sign-in. This is shown once.</>
            : <>Added <b>{invited.email}</b> to your team (they already had a Remi login).</>}
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>Team</h2>
          {canManage
            ? <button className="btn primary sm" onClick={() => { setAdding((v) => !v); setInvited(null); }}>{adding ? 'Close' : '+ Add member'}</button>
            : <span className="count">{rows.length} member{rows.length === 1 ? '' : 's'}</span>}
        </div>

        {adding && canManage && (
          <div className="form-grid" style={{ borderBottom: '1px solid var(--border-soft)' }}>
            <div className="field"><label>Email</label><input type="email" value={form.email} placeholder="name@business.co.za" onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
            <div className="field">
              <label>Role</label>
              <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {ROLES.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
              </select>
            </div>
            <div className="field" style={{ gridColumn: '1 / -1' }}><span className="faint" style={{ fontSize: 12 }}>{roleHint[form.role]}</span></div>
            <div className="field" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={invite} disabled={busy}>{busy ? 'Adding…' : 'Send invite'}</button></div>
          </div>
        )}

        <table>
          <thead><tr><th>Member</th><th>Role</th><th></th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.user_id}>
                <td>
                  <div className="primary">{m.email || '—'}{m.you && <span className="badge b-grey" style={{ marginLeft: 8 }}>You</span>}</div>
                </td>
                <td>
                  {canManage && !m.you ? (
                    <select value={m.role} disabled={busy} onChange={(e) => changeRole(m, e.target.value)} title={roleHint[m.role]}>
                      {ROLES.map((r) => <option key={r} value={r}>{r[0].toUpperCase() + r.slice(1)}</option>)}
                    </select>
                  ) : (
                    <span className="badge b-grey" style={{ textTransform: 'capitalize' }} title={roleHint[m.role]}>{m.role}</span>
                  )}
                </td>
                <td className="right">
                  {canManage && !m.you && <button className="btn sm danger" disabled={busy} onClick={() => remove(m)}>Remove</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
