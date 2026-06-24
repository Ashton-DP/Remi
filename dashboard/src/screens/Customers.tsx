import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Customer = { id: string; name?: string; phone?: string; email?: string; consent_at?: string; created_at?: string };
const date = (s?: string) => (s ? new Date(s).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export function Customers() {
  const [rows, setRows] = useState<Customer[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<{ customers: Customer[] }>('/api/customers').then((d) => setRows(d.customers)).catch((e) => setErr(e.message)); }, []);

  if (err) return <div className="banner error">{err}</div>;
  if (!rows) return <div className="empty">Loading…</div>;

  return (
    <div className="panel">
      <div className="panel-head"><h2>Customers</h2><span className="count">{rows.length}</span></div>
      {rows.length === 0 ? (
        <div className="empty">No customers yet. They'll appear here as Remi handles enquiries and bookings.</div>
      ) : (
        <table>
          <thead><tr><th>Name</th><th>Phone</th><th>Marketing consent</th><th>Added</th></tr></thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td><span className="primary">{c.name || '—'}</span></td>
                <td>{c.phone || c.email || '—'}</td>
                <td>{c.consent_at ? <span className="badge b-green">Opted in</span> : <span className="badge b-grey">None</span>}</td>
                <td>{date(c.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
