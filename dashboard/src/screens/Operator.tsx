import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Client = {
  id: string; name: string; plan: string; subscription_status: string | null;
  created_at: string; bookings: number; conversations: number; open_escalations: number;
  last_activity: string | null;
};
type Data = { clients: Client[]; totals: { clients: number; bookings: number; conversations: number; open_escalations: number; past_due: number } };

const daysSince = (s: string | null) => (s ? Math.floor((Date.now() - new Date(s).getTime()) / 86400000) : Infinity);
const planBadge = (p: string) => (p === 'complete' ? 'b-green' : p === 'standard' ? 'b-blue' : p === 'basic' ? 'b-grey' : 'b-amber');
const subBadge = (s: string | null) =>
  s === 'active' ? 'b-green' : s === 'trialing' ? 'b-blue' : s === 'past_due' ? 'b-red' : s === 'canceled' ? 'b-grey' : 'b-grey';

/** A simple health read: red = billing/escalation problem, amber = gone quiet, green = fine. */
function health(c: Client): { cls: string; label: string } {
  if (c.subscription_status === 'past_due' || c.subscription_status === 'canceled') return { cls: 'b-red', label: c.subscription_status === 'past_due' ? 'Payment failing' : 'Canceled' };
  if (c.open_escalations > 0) return { cls: 'b-amber', label: `${c.open_escalations} need attention` };
  if (daysSince(c.last_activity) > 7) return { cls: 'b-amber', label: 'Quiet 7d+' };
  return { cls: 'b-green', label: 'Healthy' };
}
const ago = (s: string | null) => {
  if (!s) return 'never';
  const d = daysSince(s);
  return d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d}d ago`;
};

export function Operator() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Data>('/api/admin/clients').then(setData).catch((e) => setErr(e.message)); }, []);

  if (err) return <div className="banner error">{err}</div>;
  if (!data) return <div className="empty">Loading…</div>;
  const t = data.totals;

  return (
    <>
      <div className="cards">
        <div className="card"><div className="card-label"><span className="accent a-purple" />Clients</div><div className="card-val">{t.clients}</div></div>
        <div className="card"><div className="card-label"><span className="accent a-teal" />Bookings</div><div className="card-val">{t.bookings}</div></div>
        <div className="card"><div className="card-label"><span className="accent a-blue" />Conversations</div><div className="card-val">{t.conversations}</div></div>
        <div className="card"><div className="card-label"><span className="accent a-amber" />Need attention</div><div className="card-val">{t.open_escalations}</div></div>
        <div className="card"><div className="card-label"><span className="accent a-red" />Payment failing</div><div className="card-val">{t.past_due}</div></div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>All clients</h2><span className="count">{data.clients.length}</span></div>
        {data.clients.length === 0 ? (
          <div className="empty">No clients yet.</div>
        ) : (
          <table>
            <thead><tr><th>Clinic</th><th>Plan</th><th>Billing</th><th>Health</th><th className="right">Bookings</th><th className="right">Convos</th><th className="right">Last active</th></tr></thead>
            <tbody>
              {data.clients.map((c) => {
                const h = health(c);
                return (
                  <tr key={c.id}>
                    <td><div className="primary">{c.name || '—'}</div><div className="secondary">since {new Date(c.created_at).toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' })}</div></td>
                    <td><span className={`badge ${planBadge(c.plan)}`} style={{ textTransform: 'capitalize' }}>{c.plan}</span></td>
                    <td><span className={`badge ${subBadge(c.subscription_status)}`}>{c.subscription_status ?? '—'}</span></td>
                    <td><span className={`badge ${h.cls}`}>{h.label}</span></td>
                    <td className="right num">{c.bookings}</td>
                    <td className="right num">{c.conversations}</td>
                    <td className="right faint">{ago(c.last_activity)}</td>
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
