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
const today = () => new Date().toISOString().slice(0, 10);
const slug = (s: string) => (s || 'conversation').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

function download(filename: string, content: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/** Full transcript of one conversation as plain text. */
function transcriptText(d: Detail): string {
  const c = client(d.conversation);
  const head =
    `Conversation with ${c.name || c.phone || 'Unknown'}\n` +
    `Channel: ${d.conversation.channel}    Status: ${d.conversation.status}\n` +
    `Exported: ${new Date().toLocaleString('en-ZA')}\n` +
    '='.repeat(48) + '\n\n';
  const body = d.messages.length
    ? d.messages.map((m) => `[${new Date(m.created_at).toLocaleString('en-ZA')}] ${m.direction === 'out' ? 'Remi' : (c.name || 'Customer')}: ${m.body}`).join('\n')
    : '(no messages)';
  return head + body + '\n';
}

/** CSV overview of every conversation (a record of all). */
function exportAllCsv(rows: Convo[]) {
  const esc = (s: any) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const header = 'Customer,Phone,Channel,Status,Last activity\n';
  const lines = rows.map((c) => {
    const cl = client(c);
    return [cl.name, cl.phone, c.channel, c.status, c.last_message_at ? new Date(c.last_message_at).toISOString() : ''].map(esc).join(',');
  }).join('\n');
  download(`conversations-${today()}.csv`, header + lines, 'text/csv');
}

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
        <div className="panel-head">
          <h2>Conversations</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="count">{rows.length}</span>
            {rows.length > 0 && <button className="btn sm" onClick={() => exportAllCsv(rows)}>Export all (CSV)</button>}
          </div>
        </div>
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
          {!detail ? <div className="faint">Loading…</div> : (
            <>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                <button className="btn sm" disabled={detail.messages.length === 0}
                  onClick={() => download(`conversation-${slug(client(detail.conversation).name || client(detail.conversation).phone || 'unknown')}-${today()}.txt`, transcriptText(detail))}>
                  Download transcript
                </button>
              </div>
              {detail.messages.length === 0 ? (
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
            </>
          )}
        </Drawer>
      )}
    </>
  );
}
