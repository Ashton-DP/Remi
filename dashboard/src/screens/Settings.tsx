import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type SettingsData = {
  role: string;
  clinic: {
    name: string; timezone: string; knowledge: string; owner_summary_phone: string;
    escalation_contact: string; chase_cadence: any; services: any[]; hours: Record<string, any>;
  };
  connections: {
    invoice_source: string | null; payment_provider: string | null;
    email_domain: string | null; email_domain_status: string | null; chasing_paused: boolean;
  };
};
const DEFAULT_CADENCE = { stage1: 1, stage2: 7, stage3: 21, cooldown: 6 };

export function Settings() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [form, setForm] = useState<any>(null);
  const [cadence, setCadence] = useState(DEFAULT_CADENCE);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<SettingsData>('/api/settings').then((d) => {
      setS(d);
      setForm({ name: d.clinic.name, timezone: d.clinic.timezone, owner_summary_phone: d.clinic.owner_summary_phone, escalation_contact: d.clinic.escalation_contact, knowledge: d.clinic.knowledge });
      setCadence({ ...DEFAULT_CADENCE, ...(d.clinic.chase_cadence || {}) });
    }).catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="banner error">{err}</div>;
  if (!s || !form) return <div className="empty">Loading…</div>;

  const canEdit = s.role === 'owner' || s.role === 'admin';
  const f = (k: string, v: string) => setForm((p: any) => ({ ...p, [k]: v }));
  const conn = s.connections;

  async function save() {
    setSaving(true); setSaved(false);
    try {
      await api('/api/settings', { method: 'POST', body: JSON.stringify({ ...form, chase_cadence: cadence }) });
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  }

  return (
    <>
      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-head"><h2>Business details</h2></div>
        <div className="form-grid">
          <div className="field"><label>Business name</label><input value={form.name} onChange={(e) => f('name', e.target.value)} disabled={!canEdit} /></div>
          <div className="field"><label>Timezone</label><input value={form.timezone} onChange={(e) => f('timezone', e.target.value)} disabled={!canEdit} /></div>
          <div className="field"><label>Owner / alerts phone</label><input value={form.owner_summary_phone} onChange={(e) => f('owner_summary_phone', e.target.value)} disabled={!canEdit} /></div>
          <div className="field"><label>Escalation contact</label><input value={form.escalation_contact} onChange={(e) => f('escalation_contact', e.target.value)} disabled={!canEdit} /></div>
          <div className="field full"><label>What Remi should know (location, parking, payment, policies…)</label><textarea rows={4} value={form.knowledge} onChange={(e) => f('knowledge', e.target.value)} disabled={!canEdit} /></div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-head"><h2>Invoice chasing schedule</h2><span className="count">days overdue</span></div>
        <div className="form-grid">
          <div className="field"><label>1st reminder — friendly</label><input type="number" min={0} value={cadence.stage1} onChange={(e) => setCadence({ ...cadence, stage1: +e.target.value })} disabled={!canEdit} /></div>
          <div className="field"><label>2nd reminder — firm</label><input type="number" min={0} value={cadence.stage2} onChange={(e) => setCadence({ ...cadence, stage2: +e.target.value })} disabled={!canEdit} /></div>
          <div className="field"><label>Final notice</label><input type="number" min={0} value={cadence.stage3} onChange={(e) => setCadence({ ...cadence, stage3: +e.target.value })} disabled={!canEdit} /></div>
          <div className="field"><label>Min days between reminders</label><input type="number" min={1} value={cadence.cooldown} onChange={(e) => setCadence({ ...cadence, cooldown: +e.target.value })} disabled={!canEdit} /></div>
        </div>
      </div>

      {canEdit ? (
        <div className="save-row"><button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>{saved && <span className="saved">Saved ✓</span>}</div>
      ) : (
        <div className="banner" style={{ background: 'var(--elev)', color: 'var(--muted)' }}>You have read-only access — ask an owner to make changes.</div>
      )}

      <div className="panel" style={{ margin: '18px 0' }}>
        <div className="panel-head"><h2>Connections</h2><span className="count">managed in setup</span></div>
        <div style={{ padding: '4px 0' }}>
          <div className="kv" style={{ padding: '14px 18px' }}><span className="k">Invoice source</span><span className="v">{conn.invoice_source ? <span className="badge b-green" style={{ textTransform: 'capitalize' }}>{conn.invoice_source}</span> : <span className="badge b-grey">Not connected</span>}</span></div>
          <div className="kv" style={{ padding: '14px 18px' }}><span className="k">Payment provider</span><span className="v">{conn.payment_provider ? <span className="badge b-green" style={{ textTransform: 'capitalize' }}>{conn.payment_provider}</span> : <span className="badge b-grey">Not set up</span>}</span></div>
          <div className="kv" style={{ padding: '14px 18px', borderBottom: 0 }}><span className="k">Email sending domain</span><span className="v">{conn.email_domain ? <span className={`badge ${conn.email_domain_status === 'verified' ? 'b-green' : 'b-amber'}`}>{conn.email_domain} · {conn.email_domain_status || 'pending'}</span> : <span className="badge b-grey">Send-on-behalf</span>}</span></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head"><h2>Services &amp; hours</h2><span className="count">read-only</span></div>
        {(s.clinic.services?.length ?? 0) === 0 ? (
          <div className="empty">No services configured.</div>
        ) : (
          <table>
            <thead><tr><th>Service</th><th>Duration</th><th className="right">Price</th></tr></thead>
            <tbody>
              {s.clinic.services.map((sv: any, i: number) => (
                <tr key={i}>
                  <td className="primary">{sv.service || sv.name || '—'}</td>
                  <td>{sv.duration_min ? `${sv.duration_min} min` : '—'}</td>
                  <td className="right amount">{sv.price_zar ? `R${sv.price_zar}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
