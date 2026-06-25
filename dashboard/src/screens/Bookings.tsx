import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Booking = {
  id: string; service: string; start_at: string; status: string; source?: string;
  clients?: { name?: string; phone?: string } | { name?: string; phone?: string }[];
};
type Wait = {
  id: string; service: string; preferred_window?: string;
  clients?: { name?: string; phone?: string } | { name?: string; phone?: string }[];
};
const who = (x: Booking | Wait) => (Array.isArray(x.clients) ? x.clients[0] : x.clients) ?? {};
const when = (s: string) => new Date(s).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const badge = (s: string) => (s === 'confirmed' ? 'b-green' : s === 'cancelled' ? 'b-red' : 'b-grey');

const blankAppt = { client_name: '', phone: '', service: '', start_at: '', duration_min: 30, _waitId: '' as string };

export function Bookings() {
  const [rows, setRows] = useState<Booking[] | null>(null);
  const [wl, setWl] = useState<Wait[]>([]);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ ...blankAppt });

  const [wlAdding, setWlAdding] = useState(false);
  const [wlForm, setWlForm] = useState({ client_name: '', phone: '', service: '', preferred_window: '' });

  function load() {
    api<{ bookings: Booking[] }>('/api/bookings').then((d) => setRows(d.bookings)).catch((e) => setErr(e.message));
    api<{ waitlist: Wait[] }>('/api/waitlist').then((d) => setWl(d.waitlist)).catch(() => {});
  }
  useEffect(load, []);

  // ── Appointments ──
  async function create() {
    if (!form.start_at) { setErr('Pick a date & time.'); return; }
    if (!form._waitId && (!form.service.trim() || (!form.phone.trim() && !form.client_name.trim()))) { setErr('Service, time and a contact are required.'); return; }
    setBusy(true); setErr('');
    try {
      if (form._waitId) {
        await api(`/api/waitlist/${form._waitId}/book`, { method: 'POST', body: JSON.stringify({ start_at: form.start_at, duration_min: form.duration_min }) });
      } else {
        await api('/api/bookings', { method: 'POST', body: JSON.stringify(form) });
      }
      setAdding(false); setForm({ ...blankAppt }); load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function cancel(b: Booking) {
    if (!confirm(`Cancel ${b.service} for ${who(b).name || 'this customer'}?`)) return;
    setBusy(true); setErr('');
    try { await api(`/api/bookings/${b.id}/cancel`, { method: 'POST' }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  // ── Waitlist ──
  async function addWait() {
    if (!wlForm.service.trim() || (!wlForm.phone.trim() && !wlForm.client_name.trim())) { setErr('Service and a contact are required.'); return; }
    setBusy(true); setErr('');
    try { await api('/api/waitlist', { method: 'POST', body: JSON.stringify(wlForm) }); setWlAdding(false); setWlForm({ client_name: '', phone: '', service: '', preferred_window: '' }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function move(w: Wait, direction: 'up' | 'down') {
    setBusy(true); setErr('');
    try { await api(`/api/waitlist/${w.id}/move`, { method: 'POST', body: JSON.stringify({ direction }) }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function removeWait(w: Wait) {
    if (!confirm(`Remove ${who(w).name || 'this customer'} from the waitlist?`)) return;
    setBusy(true); setErr('');
    try { await api(`/api/waitlist/${w.id}`, { method: 'DELETE' }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  function bookFromWait(w: Wait) {
    const c = who(w);
    setForm({ client_name: c.name || '', phone: c.phone || '', service: w.service, start_at: '', duration_min: 30, _waitId: w.id });
    setAdding(true); setErr('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (err && !rows) return <div className="banner error">{err}</div>;
  if (!rows) return <div className="empty">Loading…</div>;

  return (
    <>
      {err && <div className="banner error">{err}</div>}

      {/* APPOINTMENTS */}
      <div className="panel">
        <div className="panel-head">
          <h2>Appointments</h2>
          <button className="btn primary sm" onClick={() => { setForm({ ...blankAppt }); setAdding((v) => !v); }}>{adding ? 'Close' : '+ New appointment'}</button>
        </div>

        {adding && (
          <div className="form-grid" style={{ borderBottom: '1px solid var(--border-soft)' }}>
            {form._waitId && <div className="field" style={{ gridColumn: '1 / -1' }}><span className="faint" style={{ fontSize: 12 }}>Booking <b>{form.client_name || 'waitlisted customer'}</b> from the waitlist — just pick a time.</span></div>}
            <div className="field"><label>Customer name</label><input value={form.client_name} disabled={!!form._waitId} onChange={(e) => setForm({ ...form, client_name: e.target.value })} /></div>
            <div className="field"><label>Phone</label><input value={form.phone} disabled={!!form._waitId} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+27…" /></div>
            <div className="field"><label>Service</label><input value={form.service} disabled={!!form._waitId} onChange={(e) => setForm({ ...form, service: e.target.value })} placeholder="e.g. Botox consult" /></div>
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
                const c = who(b);
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

      {/* WAITLIST */}
      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>Waitlist <span className="count">{wl.length}</span></h2>
          <button className="btn sm" onClick={() => setWlAdding((v) => !v)}>{wlAdding ? 'Close' : '+ Add to waitlist'}</button>
        </div>

        {wlAdding && (
          <div className="form-grid" style={{ borderBottom: '1px solid var(--border-soft)' }}>
            <div className="field"><label>Customer name</label><input value={wlForm.client_name} onChange={(e) => setWlForm({ ...wlForm, client_name: e.target.value })} /></div>
            <div className="field"><label>Phone</label><input value={wlForm.phone} onChange={(e) => setWlForm({ ...wlForm, phone: e.target.value })} placeholder="+27…" /></div>
            <div className="field"><label>Service</label><input value={wlForm.service} onChange={(e) => setWlForm({ ...wlForm, service: e.target.value })} placeholder="e.g. Botox consult" /></div>
            <div className="field"><label>Preferred window</label><input value={wlForm.preferred_window} onChange={(e) => setWlForm({ ...wlForm, preferred_window: e.target.value })} placeholder="e.g. weekday mornings" /></div>
            <div className="field" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={addWait} disabled={busy}>{busy ? 'Adding…' : 'Add to waitlist'}</button></div>
          </div>
        )}

        {wl.length === 0 ? (
          <div className="empty">No one waiting. Add customers here and Remi can offer them a slot when one frees up.</div>
        ) : (
          <table>
            <thead><tr><th style={{ width: 36 }}>#</th><th>Customer</th><th>Service</th><th>Preferred</th><th></th></tr></thead>
            <tbody>
              {wl.map((w, i) => {
                const c = who(w);
                return (
                  <tr key={w.id}>
                    <td className="num faint">{i + 1}</td>
                    <td><div className="primary">{c.name || '—'}</div><div className="secondary">{c.phone || ''}</div></td>
                    <td>{w.service}</td>
                    <td className="faint">{w.preferred_window || '—'}</td>
                    <td className="right" style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn sm" disabled={busy || i === 0} title="Move up" onClick={() => move(w, 'up')}>↑</button>{' '}
                      <button className="btn sm" disabled={busy || i === wl.length - 1} title="Move down" onClick={() => move(w, 'down')}>↓</button>{' '}
                      <button className="btn sm primary" disabled={busy} onClick={() => bookFromWait(w)}>Book</button>{' '}
                      <button className="btn sm danger" disabled={busy} onClick={() => removeWait(w)}>Remove</button>
                    </td>
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
