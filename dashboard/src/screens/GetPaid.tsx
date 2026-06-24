import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Drawer } from '../components/Drawer';

type Invoice = {
  id: string; invoice_number: string; contact_name?: string; contact_phone?: string; contact_email?: string;
  amount_due: number; currency?: string; due_date: string; status: string; chase_stage: number;
  snoozed_until?: string; disputed?: boolean; source?: string;
};
type Chase = { stage: number; channel: string; recipient: string; created_at: string };

const rand = (n: number) => 'R' + (Number(n) || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2 });
const date = (s?: string) => (s ? new Date(s).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

function statusOf(inv: Invoice): { label: string; cls: string } {
  if (inv.status === 'paid') return { label: 'Paid', cls: 'b-green' };
  if (inv.disputed) return { label: 'Disputed', cls: 'b-red' };
  if (inv.snoozed_until && new Date(inv.snoozed_until) > new Date()) return { label: 'Snoozed', cls: 'b-blue' };
  return { label: 'Overdue', cls: 'b-amber' };
}

export function GetPaid() {
  const [rows, setRows] = useState<Invoice[] | null>(null);
  const [paused, setPaused] = useState(false);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Invoice | null>(null);
  const [chases, setChases] = useState<Chase[] | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    api<{ invoices: Invoice[]; chasing_paused: boolean }>('/api/invoices')
      .then((d) => { setRows(d.invoices); setPaused(d.chasing_paused); })
      .catch((e) => setErr(e.message));
  }
  useEffect(load, []);

  function open(inv: Invoice) {
    setSel(inv); setChases(null);
    api<{ chases: Chase[] }>(`/api/invoices/${inv.id}`).then((d) => setChases(d.chases)).catch(() => setChases([]));
  }

  async function toggleChasing() {
    setBusy(true);
    try { const r = await api<{ paused: boolean }>('/api/chasing', { method: 'POST', body: JSON.stringify({ paused: !paused }) }); setPaused(r.paused); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  async function act(inv: Invoice, action: 'paid' | 'snooze' | 'dispute') {
    setBusy(true);
    try {
      await api(`/api/invoices/${inv.id}/action`, { method: 'POST', body: JSON.stringify({ action }) });
      setSel(null); load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  if (err) return <div className="banner error">{err}</div>;
  if (!rows) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="panel">
        <div className="panel-head">
          <h2>Invoices</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {paused && <span className="badge b-amber">Chasing paused</span>}
            <button className={`toggle ${paused ? 'on' : ''}`} onClick={toggleChasing} disabled={busy}>
              {paused ? 'Resume chasing' : 'Pause chasing'}
            </button>
            <span className="count">{rows.length} total</span>
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="empty">No invoices yet. Connect an accounting source or import a CSV to start chasing.</div>
        ) : (
          <table>
            <thead><tr><th>Invoice</th><th>Customer</th><th className="right">Amount</th><th>Due</th><th>Stage</th><th>Status</th></tr></thead>
            <tbody>
              {rows.map((inv) => {
                const s = statusOf(inv);
                return (
                  <tr key={inv.id} className="clickable" onClick={() => open(inv)}>
                    <td><span className="primary">{inv.invoice_number}</span></td>
                    <td><div className="primary">{inv.contact_name || '—'}</div><div className="secondary">{inv.contact_phone || inv.contact_email || ''}</div></td>
                    <td className="right amount">{rand(inv.amount_due)}</td>
                    <td>{date(inv.due_date)}</td>
                    <td>{inv.chase_stage ? `Stage ${inv.chase_stage}` : <span className="faint">—</span>}</td>
                    <td><span className={`badge ${s.cls}`}>{s.label}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {sel && (
        <Drawer title={`Invoice ${sel.invoice_number}`} onClose={() => setSel(null)}>
          <div className="kv"><span className="k">Customer</span><span className="v">{sel.contact_name || '—'}</span></div>
          <div className="kv"><span className="k">Amount due</span><span className="v">{rand(sel.amount_due)}</span></div>
          <div className="kv"><span className="k">Due date</span><span className="v">{date(sel.due_date)}</span></div>
          <div className="kv"><span className="k">Status</span><span className="v"><span className={`badge ${statusOf(sel).cls}`}>{statusOf(sel).label}</span></span></div>
          <div className="kv"><span className="k">Source</span><span className="v" style={{ textTransform: 'capitalize' }}>{sel.source || '—'}</span></div>
          <div className="kv"><span className="k">Contact</span><span className="v">{sel.contact_phone || sel.contact_email || '—'}</span></div>

          {sel.status !== 'paid' && (
            <div className="btn-row">
              <button className="btn primary" disabled={busy} onClick={() => act(sel, 'paid')}>Mark paid</button>
              <button className="btn" disabled={busy} onClick={() => act(sel, 'snooze')}>Snooze 5 days</button>
              <button className="btn danger" disabled={busy} onClick={() => act(sel, 'dispute')}>Dispute</button>
            </div>
          )}

          <h4 style={{ margin: '22px 0 12px', fontSize: 13 }}>Chase timeline</h4>
          {!chases ? <div className="faint">Loading…</div> : chases.length === 0 ? (
            <div className="faint">Not chased yet.</div>
          ) : (
            <div className="timeline">
              {chases.map((c, i) => (
                <div className="tl-item" key={i}>
                  <div className="tl-dot">{c.stage}</div>
                  <div className="tl-body">
                    <div className="tl-title">Stage {c.stage} reminder · {c.channel}</div>
                    <div className="tl-meta">{c.recipient} · {new Date(c.created_at).toLocaleString('en-ZA')}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Drawer>
      )}
    </>
  );
}
