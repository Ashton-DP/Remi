import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Member = { user_id: string; role: string; email: string | null; you: boolean };
const ROLES = ['owner', 'admin', 'staff'];

export function TeamPanel() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [err, setErr] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('staff');
  const [busy, setBusy] = useState(false);
  const [invited, setInvited] = useState<{ email: string; temp_password?: string; existing?: boolean } | null>(null);

  function load() {
    api<{ members: Member[]; can_manage: boolean }>('/api/team')
      .then((d) => { setMembers(d.members); setCanManage(d.can_manage); })
      .catch((e) => setErr(e.message));
  }
  useEffect(load, []);

  async function invite() {
    if (!email.trim()) return;
    setBusy(true); setErr(''); setInvited(null);
    try {
      const r = await api<{ email: string; temp_password?: string; existing?: boolean }>('/api/team/invite', { method: 'POST', body: JSON.stringify({ email: email.trim(), role }) });
      setInvited(r); setEmail(''); load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function changeRole(m: Member, newRole: string) {
    setBusy(true); setErr('');
    try { await api(`/api/team/${m.user_id}/role`, { method: 'POST', body: JSON.stringify({ role: newRole }) }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function remove(m: Member) {
    if (!confirm(`Remove ${m.email ?? 'this member'} from the team?`)) return;
    setBusy(true); setErr('');
    try { await api(`/api/team/${m.user_id}`, { method: 'DELETE' }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (!members) return null;

  return (
    <div className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-head"><h2>Team</h2><span className="count">{members.length} member{members.length === 1 ? '' : 's'}</span></div>
      {err && <div className="banner error" style={{ margin: 14 }}>{err}</div>}
      <table>
        <thead><tr><th>Email</th><th>Role</th>{canManage && <th></th>}</tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.user_id}>
              <td><span className="primary">{m.email ?? '—'}</span>{m.you && <span className="badge b-blue" style={{ marginLeft: 8 }}>you</span>}</td>
              <td>
                {canManage && !m.you ? (
                  <select className="conn-input" style={{ width: 120 }} value={m.role} onChange={(e) => changeRole(m, e.target.value)} disabled={busy}>
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                ) : <span className="badge b-grey" style={{ textTransform: 'capitalize' }}>{m.role}</span>}
              </td>
              {canManage && <td className="right">{!m.you && <button className="btn sm danger" disabled={busy} onClick={() => remove(m)}>Remove</button>}</td>}
            </tr>
          ))}
        </tbody>
      </table>

      {canManage && (
        <div style={{ padding: 18, borderTop: '1px solid var(--border-soft)' }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 1, minWidth: 200 }}><label>Invite by email</label><input className="conn-input" type="email" placeholder="name@clinic.co.za" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
            <div className="field" style={{ minWidth: 120 }}><label>Role</label><select className="conn-input" value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
            <button className="btn primary" disabled={busy || !email.trim()} onClick={invite}>Add member</button>
          </div>
          {invited && (
            <div className="banner" style={{ background: 'var(--green-bg)', color: 'var(--green)', marginTop: 14 }}>
              {invited.existing
                ? <>Added <b>{invited.email}</b> to the team — they can sign in with their existing password.</>
                : <>Created <b>{invited.email}</b>. Temporary password: <code style={{ background: 'var(--bg)', padding: '2px 8px', borderRadius: 6, color: 'var(--text)' }}>{invited.temp_password}</code> — share it with them; they should change it after first sign-in.</>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
