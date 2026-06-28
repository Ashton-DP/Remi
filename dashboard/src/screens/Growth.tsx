import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Proposal = {
  id: string; type: string; status: string; title: string; detail?: string;
  payload?: any; owner_input?: any; results?: any; created_at: string;
};
type Settings = {
  max_discount_pct: number;
  gap_fill: { enabled: boolean; approval: string };
  winback: { enabled: boolean; approval: string; cadence_buffer_days: number };
  referral: { enabled: boolean; reward: string };
  review: { enabled: boolean };
  offpeak: { enabled: boolean; approval: string; windows: string };
};
type Data = { proposals: Proposal[]; settings: Settings; pending: number };

const TYPE_LABEL: Record<string, string> = {
  gap_fill: '🗓️ Fill a gap', winback: '💌 Win back regulars', referral: '🤝 Referrals',
  review: '⭐ Reviews', offpeak: '🌙 Off-peak offer',
};
const date = (s: string) => new Date(s).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });

export function Growth() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [discount, setDiscount] = useState<Record<string, string>>({});
  const [s, setS] = useState<Settings | null>(null);
  const [savedMsg, setSavedMsg] = useState('');

  function load() { api<Data>('/api/growth').then((x) => { setD(x); setS(x.settings); }).catch((e) => setErr(e.message)); }
  useEffect(load, []);

  async function decide(p: Proposal, action: 'approve' | 'decline') {
    setBusy(p.id); setErr('');
    const owner_input = action === 'approve' && Number(discount[p.id]) > 0 ? { discount_pct: Number(discount[p.id]) } : undefined;
    try {
      const r = await api<{ results?: any }>(`/api/growth/${p.id}/decide`, { method: 'POST', body: JSON.stringify({ action, owner_input }) });
      if (action === 'approve' && r.results?.sent != null) setSavedMsg(`Sent to ${r.results.sent} client${r.results.sent === 1 ? '' : 's'}.`);
      load();
    } catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  }

  async function saveSettings() {
    if (!s) return;
    setBusy('settings'); setErr('');
    try { await api('/api/growth/settings', { method: 'POST', body: JSON.stringify({ settings: s }) }); setSavedMsg('Growth settings saved.'); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(null); }
  }

  if (err) return <div className="banner error">{err}</div>;
  if (!d || !s) return <div className="empty">Loading…</div>;

  const pending = d.proposals.filter((p) => p.status === 'pending');
  const history = d.proposals.filter((p) => p.status !== 'pending').slice(0, 20);
  const cap = s.max_discount_pct;

  return (
    <>
      {savedMsg && <div className="banner" style={{ borderColor: 'var(--green)', color: 'var(--green)' }}>{savedMsg}</div>}

      {/* Pending proposals — owner approves the specifics */}
      <div className="panel">
        <div className="panel-head"><h2>Remi suggests</h2><span className="count">{pending.length} waiting</span></div>
        {pending.length === 0 ? (
          <div className="empty">Nothing to approve right now. Remi will flag opportunities to fill your diary here.</div>
        ) : (
          <div className="needs">
            {pending.map((p) => (
              <div className="needs-row" key={p.id} style={{ alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <div className="needs-reason">{TYPE_LABEL[p.type] ?? p.type} — {p.title}</div>
                  {p.detail && <div className="needs-summary">{p.detail}</div>}
                  {cap > 0 && (
                    <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label style={{ fontSize: 13, color: 'var(--muted)' }}>Discount %</label>
                      <input type="number" min={0} max={cap} placeholder="0" style={{ width: 70 }}
                        value={discount[p.id] ?? ''} onChange={(e) => setDiscount({ ...discount, [p.id]: e.target.value })} />
                      <span style={{ fontSize: 12, color: 'var(--faint)' }}>max {cap}%</span>
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <button className="btn sm primary" disabled={busy === p.id} onClick={() => decide(p, 'approve')}>{busy === p.id ? '…' : 'Approve & send'}</button>
                  <button className="btn sm" disabled={busy === p.id} onClick={() => decide(p, 'decline')}>Decline</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Guardrails */}
      <div className="panel">
        <div className="panel-head"><h2>Growth settings</h2><span className="count">your guardrails</span></div>
        <p className="muted" style={{ marginBottom: 16, fontSize: 13.5 }}>Remi only ever acts within these. It proposes; you approve — unless you switch a type to “auto.”</p>
        <div className="field" style={{ maxWidth: 280, marginBottom: 18 }}>
          <label>Max discount Remi may offer (%)</label>
          <input type="number" min={0} max={100} value={s.max_discount_pct}
            onChange={(e) => setS({ ...s, max_discount_pct: Math.max(0, Math.min(100, +e.target.value)) })} />
        </div>
        {([
          ['gap_fill', 'Fill empty slots from your waitlist & lapsed regulars'],
          ['winback', 'Win back clients overdue for their usual visit'],
          ['offpeak', 'Promote your quiet times to fill them'],
          ['referral', 'Ask happy clients to refer a friend'],
          ['review', 'Ask happy clients for a Google review'],
        ] as [keyof Settings, string][]).map(([key, label]) => {
          const cfg: any = s[key];
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, fontSize: 14 }}>
                <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => setS({ ...s, [key]: { ...cfg, enabled: e.target.checked } })} />
                <span><strong>{TYPE_LABEL[key as string]}</strong><br /><span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{label}</span></span>
              </label>
              {'approval' in cfg && (
                <select value={cfg.approval} onChange={(e) => setS({ ...s, [key]: { ...cfg, approval: e.target.value } })} style={{ maxWidth: 130 }}>
                  <option value="ask">Ask me first</option>
                  <option value="auto">Auto (within cap)</option>
                </select>
              )}
            </div>
          );
        })}
        <div className="field" style={{ marginTop: 14 }}>
          <label>Referral reward (what both people get)</label>
          <input placeholder="e.g. R50 off for both of you" value={s.referral.reward}
            onChange={(e) => setS({ ...s, referral: { ...s.referral, reward: e.target.value } })} />
        </div>
        <div className="field" style={{ marginTop: 10 }}>
          <label>Your quiet times (for off-peak offers)</label>
          <input placeholder="e.g. Tuesday & Wednesday mornings" value={s.offpeak.windows}
            onChange={(e) => setS({ ...s, offpeak: { ...s.offpeak, windows: e.target.value } })} />
        </div>
        <div style={{ marginTop: 16 }}><button className="btn primary" disabled={busy === 'settings'} onClick={saveSettings}>{busy === 'settings' ? 'Saving…' : 'Save settings'}</button></div>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="panel">
          <div className="panel-head"><h2>Recent campaigns</h2></div>
          <table>
            <thead><tr><th>Campaign</th><th>Status</th><th>Result</th><th>When</th></tr></thead>
            <tbody>
              {history.map((p) => (
                <tr key={p.id}>
                  <td><span className="primary">{TYPE_LABEL[p.type] ?? p.type}</span> — {p.title}</td>
                  <td><span className={`badge ${p.status === 'sent' ? 'b-green' : 'b-grey'}`}>{p.status}</span></td>
                  <td>{p.results?.sent != null ? `Sent to ${p.results.sent}${p.results.discount_pct ? ` · ${p.results.discount_pct}% off` : ''}` : '—'}</td>
                  <td>{date(p.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
