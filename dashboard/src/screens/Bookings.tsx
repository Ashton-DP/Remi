import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Booking = {
  id: string; service: string; start_at: string; status: string; source?: string;
  clients?: { name?: string; phone?: string } | { name?: string; phone?: string }[];
};
const client = (b: Booking) => (Array.isArray(b.clients) ? b.clients[0] : b.clients) ?? {};
const when = (s: string) => new Date(s).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const badge = (s: string) => (s === 'confirmed' ? 'b-green' : s === 'cancelled' ? 'b-red' : 'b-grey');

export function Bookings() {
  const [rows, setRows] = useState<Booking[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<{ bookings: Booking[] }>('/api/bookings').then((d) => setRows(d.bookings)).catch((e) => setErr(e.message)); }, []);

  if (err) return <div className="banner error">{err}</div>;
  if (!rows) return <div className="empty">Loading…</div>;

  return (
    <div className="panel">
      <div className="panel-head"><h2>Appointments</h2><span className="count">{rows.length}</span></div>
      {rows.length === 0 ? (
        <div className="empty">No appointments yet. They'll appear here as Remi books them.</div>
      ) : (
        <table>
          <thead><tr><th>Customer</th><th>Service</th><th>When</th><th>Source</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((b) => {
              const c = client(b);
              return (
                <tr key={b.id}>
                  <td><div className="primary">{c.name || '—'}</div><div className="secondary">{c.phone || ''}</div></td>
                  <td>{b.service}</td>
                  <td>{when(b.start_at)}</td>
                  <td style={{ textTransform: 'capitalize' }} className="faint">{b.source || '—'}</td>
                  <td><span className={`badge ${badge(b.status)}`}>{b.status}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
