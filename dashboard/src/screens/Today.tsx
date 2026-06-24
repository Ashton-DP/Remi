import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type TodayData = {
  clinic: { name: string; chasing_paused: boolean } | null;
  today: {
    appointments: number; conversations_24h: number;
    overdue_invoices: number; overdue_total_zar: number; open_escalations: number;
  };
  needs_you: { id: string; reason: string; summary?: string; created_at: string }[];
};

const rand = (n: number) => 'R' + (n || 0).toLocaleString('en-ZA');

export function Today() {
  const [d, setD] = useState<TodayData | null>(null);
  const [err, setErr] = useState('');

  useEffect(() => { api<TodayData>('/api/today').then(setD).catch((e) => setErr(e.message)); }, []);

  if (err) return <div className="banner error">{err}</div>;
  if (!d) return <div className="boot">Loading today…</div>;

  const cards = [
    { label: "Today's appointments", value: d.today.appointments, tone: 'purple' },
    { label: 'Conversations (24h)', value: d.today.conversations_24h, tone: 'teal' },
    { label: 'Overdue invoices', value: d.today.overdue_invoices, tone: 'amber' },
    { label: 'Outstanding', value: rand(d.today.overdue_total_zar), tone: 'amber' },
    { label: 'Needs you', value: d.today.open_escalations, tone: d.today.open_escalations ? 'red' : 'green' },
  ];

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Today</h1>
        <p className="muted">Here's what Remi is handling right now.</p>
        {d.clinic?.chasing_paused && <span className="pill paused">Invoice chasing paused</span>}
      </header>

      <section className="cards">
        {cards.map((c) => (
          <div key={c.label} className={`card tone-${c.tone}`}>
            <div className="card-val">{c.value}</div>
            <div className="card-label">{c.label}</div>
          </div>
        ))}
      </section>

      <section className="panel">
        <h2>Needs you</h2>
        {d.needs_you.length === 0 ? (
          <p className="muted empty">All clear — nothing waiting on you. ✨</p>
        ) : (
          <ul className="needs-list">
            {d.needs_you.map((e) => (
              <li key={e.id}>
                <span className="needs-reason">{e.reason}</span>
                <span className="needs-summary">{e.summary ?? ''}</span>
                <span className="needs-time">{new Date(e.created_at).toLocaleString('en-ZA')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
