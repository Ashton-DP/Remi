import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Booking = {
  id: string; service: string; start_at: string; status: string; source?: string;
  clients?: { name?: string; phone?: string } | { name?: string; phone?: string }[];
};
const client = (b: Booking) => (Array.isArray(b.clients) ? b.clients[0] : b.clients) ?? {};
const when = (s: string) => new Date(s).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const badge = (s: string) => (s === 'confirmed' ? 'b-green' : s === 'cancelled' ? 'b-red' : 'b-grey');

export function Bookings() {
  const [rows, setRows] = useState<Booking[] | null>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ client_name: '', phone: '', service: '', start_at: '', duration_min: 30 });

  function load() { api<{ bookings: Booking[] }>('/api/bookings').then((d) => setRows(d.bookings)).catch((e) => setErr(e.message)); }
  useEffect(load, []);

  async function create() {
    if (!form.service.trim() || !form.start_at || (!form.phone.trim() && !form.client_name.trim())) { setErr('Service, time and a contact are required.'); return; }
    setBusy(true); setErr('');
    try { await api('/api/bookings', { method: 'POST', body: JSON.stringify(form) }); setAdding(false); setForm({ client_name: '', phone: '', service: '', start_at: '', duration_min: 30 }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function cancel(b: Booking) {
    if (!confirm(`Cancel ${b.service} for ${client(b).name || 'this customer'}?`)) return;
    setBusy(true); setErr('');
    try { await api(`/api/bookings/${b.id}/cancel`, { method: 'POST' }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (err && !rows) return <div className="banner error">{err}</div>;
  if (!rows) return <div className="empty">Loading…</div>;

  return (
    <>
      {err && <div className="banner error">{err}</div>}
      <div className="panel">
        <div className="panel-head">
          <h2>Appointments</h2>
          <button className="btn primary sm" onClick={() => setAdding((v) => !v)}>{adding ? 'Close' : '+ New appointment'}</button>
        </div>

        {adding && (
          <div className="form-grid" style={{ borderBottom: '1px solid var(--border-soft)' }}>
            <div className="field"><label>Customer name</label><input value={form.client_name} onChange={(e) => setForm({ ...form, client_name: e.target.value })} /></div>
            <div className="field"><label>Phone</label><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+27…" /></div>
            <div className="field"><label>Service</label><input value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} placeholder="e.g. Botox consult" /></div>
            <div className="field"><label>Date &amp; time</label><input type="datetime-local" value={form.start_at} onChange={(e) => setForm({ ...form, start_at: e.target.value })} /></div>
            <div className="field"><label>Duration (min)</label><input type="number" min={5} value={form.duration_min} onChange={(e) => setForm({ ...form, duration_min: +e.target.value })} /></div>
            <div className="field" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={create} disabled={busy}>{busy ? 'Booking…' : 'Book appointment'}</button></div>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="empty">No appointments yet. Add one above, or they'll appear here as Remi books them.</div>
        ) : (
          <table>
            <thead><tr><th>Customer</th><th>Service</th><th>When</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {rows.map((b) => {
                const c = client(b);
                return (
                  <tr key={b.id}>
                    <td><div className="primary">{c.name || '—'}</div><div className="secondary">{c.phone || ''}</div></td>
                    <td>{b.service}</td>
                    <td>{when(b.start_at)}</td>
                    <td><span className={`badge ${badge(b.status)}`}>{b.status}</span></td>
                    <td className="right">{b.status === 'confirmed' && <button className="btn sm danger" disabled={busy} onClick={() => cancel(b)}>Cancel</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
