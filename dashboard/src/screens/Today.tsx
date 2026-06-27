import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../components/icons';

type TodayData = {
  clinic: { name: string; chasing_paused: boolean } | null;
  today: { appointments: number; conversations_24h: number; overdue_invoices: number; overdue_total_zar: number; open_escalations: number };
  needs_you: { id: string; reason: string; summary?: string; created_at: string }[];
  setup?: { whatsapp_connected: boolean; whatsapp_pending: boolean; calendar_connected: boolean; payment_connected: boolean };
};
const rand = (n: number) => 'R' + (n || 0).toLocaleString('en-ZA');

export function Today() {
  const [d, setD] = useState<TodayData | null>(null);
  const [err, setErr] = useState('');
  const [resolving, setResolving] = useState<string | null>(null);
  useEffect(() => { api<TodayData>('/api/today').then(setD).catch((e) => setErr(e.message)); }, []);

  async function resolve(id: string) {
    setResolving(id);
    try {
      await api(`/api/escalations/${id}/resolve`, { method: 'POST' });
      setD((cur) => cur ? { ...cur, needs_you: cur.needs_you.filter((e) => e.id !== id), today: { ...cur.today, open_escalations: Math.max(0, cur.today.open_escalations - 1) } } : cur);
    } catch (e: any) { setErr(e.message); } finally { setResolving(null); }
  }

  if (err) return <div className="banner error">{err}</div>;
  if (!d) return <div className="empty">Loading…</div>;

  const cards = [
    { label: "Appointments today", value: d.today.appointments, accent: 'a-purple' },
    { label: 'Conversations (24h)', value: d.today.conversations_24h, accent: 'a-teal' },
    { label: 'Overdue invoices', value: d.today.overdue_invoices, accent: 'a-amber' },
    { label: 'Outstanding', value: rand(d.today.overdue_total_zar), accent: 'a-amber' },
    { label: 'Needs you', value: d.today.open_escalations, accent: d.today.open_escalations ? 'a-red' : 'a-green' },
  ];

  // Surface anything not yet connected so the owner knows they're not fully live.
  const s = d.setup;
  const setupItems = s ? [
    { done: s.whatsapp_connected, pending: s.whatsapp_pending, label: 'WhatsApp', hint: s.whatsapp_pending ? 'Submitted — we’re connecting your number' : 'Connect your WhatsApp number' },
    { done: s.calendar_connected, pending: false, label: 'Calendar', hint: 'Connect Google Calendar so Remi can book' },
    { done: s.payment_connected, pending: false, label: 'Payments', hint: 'Connect a provider to take deposits & invoices' },
  ].filter((i) => !i.done) : [];

  return (
    <>
      {setupItems.length > 0 && (
        <div className="panel" style={{ borderColor: 'var(--amber)' }}>
          <div className="panel-head">
            <h2>Finish setting up</h2>
            <span className="count">{setupItems.length} to go</span>
          </div>
          <div className="needs">
            {setupItems.map((i) => (
              <div className="needs-row" key={i.label}>
                <span className="needs-ico"><Icon name="alert" size={16} /></span>
                <div>
                  <div className="needs-reason">{i.label}{i.pending && <span className="badge b-amber" style={{ marginLeft: 8 }}>Pending</span>}</div>
                  <div className="needs-summary">{i.hint}</div>
                </div>
                {!i.pending && <a className="btn sm" href="#settings" onClick={(e) => { e.preventDefault(); window.dispatchEvent(new CustomEvent('remi:nav', { detail: 'settings' })); }}>Set up</a>}
              </div>
            ))}
          </div>
        </div>
      )}

      <section className="cards">
        {cards.map((c) => (
          <div key={c.label} className="card">
            <div className="card-label"><span className={`accent ${c.accent}`} />{c.label}</div>
            <div className="card-val num">{c.value}</div>
          </div>
        ))}
      </section>

      <div className="panel">
        <div className="panel-head">
          <h2>Needs you</h2>
          <span className="count">{d.needs_you.length} item{d.needs_you.length === 1 ? '' : 's'}</span>
        </div>
        {d.needs_you.length === 0 ? (
          <div className="empty">Nothing waiting on you. Remi has it under control.</div>
        ) : (
          <div className="needs">
            {d.needs_you.map((e) => (
              <div className="needs-row" key={e.id}>
                <span className="needs-ico"><Icon name="alert" size={16} /></span>
                <div>
                  <div className="needs-reason">{e.reason}</div>
                  {e.summary && <div className="needs-summary">{e.summary}</div>}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span className="needs-time">{new Date(e.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</span>
                  <button className="btn sm" disabled={resolving === e.id} onClick={() => resolve(e.id)}>{resolving === e.id ? '…' : 'Resolve'}</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
