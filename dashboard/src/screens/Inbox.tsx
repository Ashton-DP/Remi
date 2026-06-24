import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Drawer } from '../components/Drawer';

type Convo = {
  id: string; channel: string; status: string; last_message_at: string;
  clients?: { name?: string; phone?: string } | { name?: string; phone?: string }[];
};
type Msg = { direction: 'in' | 'out'; body: string; created_at: string };
type Detail = { conversation: Convo; messages: Msg[] };

const client = (c: Convo) => (Array.isArray(c.clients) ? c.clients[0] : c.clients) ?? {};
const ago = (s: string) => new Date(s).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const badge = (s: string) => (s === 'open' ? 'b-blue' : s === 'escalated' ? 'b-amber' : s === 'booked' ? 'b-green' : 'b-grey');

export function Inbox() {
  const [rows, setRows] = useState<Convo[] | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Convo | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);

  useEffect(() => { api<{ conversations: Convo[] }>('/api/conversations').then((d) => setRows(d.conversations)).catch((e) => setErr(e.message)); }, []);
  function open(c: Convo) { setSel(c); setDetail(null); api<Detail>(`/api/conversations/${c.id}`).then(setDetail).catch(() => setDetail({ conversation: c, messages: [] })); }

  if (err) return <div className="banner error">{err}</div>;
  if (!rows) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="panel">
        <div className="panel-head"><h2>Conversations</h2><span className="count">{rows.length}</span></div>
        {rows.length === 0 ? (
          <div className="empty">No conversations yet. Calls and messages Remi handles will appear here.</div>
        ) : (
          <table>
            <thead><tr><th>Customer</th><th>Channel</th><th>Last activity</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((c) => {
                const cl = client(c);
                return (
                  <tr key={c.id} className="clickable" onClick={() => open(c)}>
                    <td><div className="primary">{cl.name || cl.phone || 'Unknown'}</div><div className="secondary">{cl.name ? cl.phone : ''}</div></td>
                    <td style={{ textTransform: 'capitalize' }} className="faint">{c.channel}</td>
                    <td>{c.last_message_at ? ago(c.last_message_at) : '—'}</td>
                    <td><span className={`badge ${badge(c.status)}`}>{c.status}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {sel && (
        <Drawer title={(client(sel).name || client(sel).phone || 'Conversation')} onClose={() => setSel(null)}>
          {!detail ? <div className="faint">Loading…</div> : detail.messages.length === 0 ? (
            <div className="faint">No messages.</div>
          ) : (
            <div className="transcript">
              {detail.messages.map((m, i) => (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.direction === 'out' ? 'flex-end' : 'flex-start' }}>
                  <div className={`bubble ${m.direction}`}>{m.body}</div>
                  <span className="bubble-time">{new Date(m.created_at).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))}
            </div>
          )}
        </Drawer>
      )}
    </>
  );
}
