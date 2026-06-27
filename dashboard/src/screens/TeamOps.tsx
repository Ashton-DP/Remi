import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Data = {
  role: string;
  clocked_in: { name: string; since: string }[];
  hours: { staff_id: string; name: string; label: string }[];
  leave: { id: string; name: string; start: string; end: string; type: string; reason: string; status: string }[];
  staff: { id: string; name: string; phone: string | null; role: string; active: boolean }[];
};

function since(iso: string) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function TeamOps() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [nf, setNf] = useState({ name: '', phone: '', role: 'practitioner' });

  function load() { api<Data>('/api/team-ops').then(setD).catch((e) => setErr(e.message)); }
  useEffect(load, []);

  if (err) return <div className="banner error">{err}</div>;
  if (!d) return <div className="empty">Loading…</div>;
  const canEdit = d.role === 'owner' || d.role === 'admin';

  async function decide(id: string, status: 'approved' | 'declined') {
    setBusy(true);
    try { await api(`/api/team-ops/leave/${id}`, { method: 'POST', body: JSON.stringify({ status }) }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function addStaff() {
    if (!nf.name.trim()) return;
    setBusy(true);
    try { await api('/api/team-ops/staff', { method: 'POST', body: JSON.stringify(nf) }); setNf({ name: '', phone: '', role: 'practitioner' }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function removeStaff(id: string) {
    setBusy(true);
    try { await api(`/api/team-ops/staff/${id}`, { method: 'DELETE' }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const pendingLeave = d.leave.filter((l) => l.status === 'pending');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Clocked in now */}
      <div className="panel">
        <div className="panel-head"><h2>On the clock now</h2><span className="count">{d.clocked_in.length}</span></div>
        <div style={{ padding: 18 }}>
          {d.clocked_in.length === 0 && <div className="faint">Nobody's clocked in right now.</div>}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {d.clocked_in.map((c, i) => (
              <div key={i} className="badge b-green" style={{ padding: '8px 14px' }}>● {c.name} · {since(c.since)}</div>
            ))}
          </div>
        </div>
      </div>

      {/* Hours this week */}
      <div className="panel">
        <div className="panel-head"><h2>Hours this week</h2></div>
        <div style={{ padding: 18 }}>
          {d.hours.length === 0 && <div className="faint">No hours logged yet this week.</div>}
          {d.hours.map((h) => (
            <div key={h.staff_id} className="conn-row">
              <div className="conn-title">{h.name}</div>
              <span className="badge b-grey">{h.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Leave requests */}
      <div className="panel">
        <div className="panel-head"><h2>Leave requests</h2>{pendingLeave.length > 0 && <span className="count" style={{ color: 'var(--amber)' }}>{pendingLeave.length} pending</span>}</div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {d.leave.length === 0 && <div className="faint">No leave requests.</div>}
          {d.leave.map((l) => (
            <div key={l.id} className="conn-row">
              <div>
                <div className="conn-title">{l.name} · {l.start}{l.end !== l.start ? ` → ${l.end}` : ''}</div>
                <div className="conn-sub">{l.type}{l.reason ? ` — ${l.reason}` : ''}</div>
              </div>
              {l.status === 'pending' ? (
                canEdit ? (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn sm primary" disabled={busy} onClick={() => decide(l.id, 'approved')}>Approve</button>
                    <button className="btn sm danger" disabled={busy} onClick={() => decide(l.id, 'declined')}>Decline</button>
                  </div>
                ) : <span className="badge b-amber">Pending</span>
              ) : (
                <span className={`badge ${l.status === 'approved' ? 'b-green' : 'b-grey'}`} style={{ textTransform: 'capitalize' }}>{l.status}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Staff roster */}
      <div className="panel">
        <div className="panel-head"><h2>Staff</h2><span className="count">{d.staff.length}</span></div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {d.staff.map((s) => (
            <div key={s.id} className="conn-row">
              <div>
                <div className="conn-title">{s.name} <span className="conn-sub" style={{ textTransform: 'capitalize' }}>· {s.role}</span></div>
                <div className="conn-sub">{s.phone || 'no phone — can’t use WhatsApp clock-in'}</div>
              </div>
              {canEdit && <button className="btn sm danger" disabled={busy} onClick={() => removeStaff(s.id)}>Remove</button>}
            </div>
          ))}
          {canEdit && (
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              <input className="conn-input" placeholder="Name" value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} />
              <input className="conn-input" placeholder="WhatsApp number (+27…)" value={nf.phone} onChange={(e) => setNf({ ...nf, phone: e.target.value })} />
              <select className="conn-input" style={{ maxWidth: 150 }} value={nf.role} onChange={(e) => setNf({ ...nf, role: e.target.value })}>
                <option value="practitioner">Practitioner</option>
                <option value="admin">Admin</option>
                <option value="owner">Owner</option>
              </select>
              <button className="btn primary" disabled={busy || !nf.name.trim()} onClick={addStaff}>Add staff</button>
            </div>
          )}
          <div className="conn-sub" style={{ marginTop: 6 }}>Staff with a WhatsApp number can text Remi to clock in/out, check hours, and request leave.</div>
        </div>
      </div>
    </div>
  );
}
