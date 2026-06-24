import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../components/icons';

type TodayData = {
  clinic: { name: string; chasing_paused: boolean } | null;
  today: { appointments: number; conversations_24h: number; overdue_invoices: number; overdue_total_zar: number; open_escalations: number };
  needs_you: { id: string; reason: string; summary?: string; created_at: string }[];
};
const rand = (n: number) => 'R' + (n || 0).toLocaleString('en-ZA');

export function Today() {
  const [d, setD] = useState<TodayData | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<TodayData>('/api/today').then(setD).catch((e) => setErr(e.message)); }, []);

  if (err) return <div className="banner error">{err}</div>;
  if (!d) return <div className="empty">Loading…</div>;

  const cards = [
    { label: "Appointments today", value: d.today.appointments, accent: 'a-purple' },
    { label: 'Conversations (24h)', value: d.today.conversations_24h, accent: 'a-teal' },
    { label: 'Overdue invoices', value: d.today.overdue_invoices, accent: 'a-amber' },
    { label: 'Outstanding', value: rand(d.today.overdue_total_zar), accent: 'a-amber' },
    { label: 'Needs you', value: d.today.open_escalations, accent: d.today.open_escalations ? 'a-red' : 'a-green' },
  ];

  return (
    <>
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
                <span className="needs-time">{new Date(e.created_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
