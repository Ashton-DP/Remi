import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Data = {
  stats: { bookedN: number; bookedR: number; recoveredR: number; noShowRate: number; escalations: number };
  insights: { conversionRate: number; afterHoursPct: number; topService: string; busiestDay: string };
  conversations_30d: number;
};
const rand = (n: number) => 'R' + (Number(n) || 0).toLocaleString('en-ZA');

export function Insights() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Data>('/api/insights').then(setD).catch((e) => setErr(e.message)); }, []);

  if (err) return <div className="banner error">{err}</div>;
  if (!d) return <div className="empty">Loading…</div>;

  const money = [
    { label: 'Revenue captured', value: rand(d.stats.bookedR), accent: 'a-purple' },
    { label: 'Revenue recovered', value: rand(d.stats.recoveredR), accent: 'a-teal' },
    { label: 'Bookings made', value: d.stats.bookedN, accent: 'a-purple' },
    { label: 'Conversations', value: d.conversations_30d, accent: 'a-blue' },
  ];
  const perf = [
    { label: 'Conversion rate', value: `${d.insights.conversionRate}%`, accent: 'a-green' },
    { label: 'After-hours', value: `${d.insights.afterHoursPct}%`, accent: 'a-blue' },
    { label: 'No-show rate', value: `${d.stats.noShowRate}%`, accent: 'a-amber' },
    { label: 'Escalations', value: d.stats.escalations, accent: 'a-red' },
  ];

  return (
    <>
      <section className="cards">
        {money.map((c) => (
          <div key={c.label} className="card">
            <div className="card-label"><span className={`accent ${c.accent}`} />{c.label}</div>
            <div className="card-val num">{c.value}</div>
          </div>
        ))}
      </section>
      <section className="cards">
        {perf.map((c) => (
          <div key={c.label} className="card">
            <div className="card-label"><span className={`accent ${c.accent}`} />{c.label}</div>
            <div className="card-val num sm">{c.value}</div>
          </div>
        ))}
      </section>
      <div className="panel">
        <div className="panel-head"><h2>At a glance</h2><span className="count">last 30 days</span></div>
        <div style={{ padding: '4px 0' }}>
          <div className="kv" style={{ padding: '14px 18px' }}><span className="k">Top service</span><span className="v">{d.insights.topService}</span></div>
          <div className="kv" style={{ padding: '14px 18px', borderBottom: 0 }}><span className="k">Busiest day</span><span className="v">{d.insights.busiestDay}</span></div>
        </div>
      </div>
    </>
  );
}
