import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type SettingsData = {
  role: string;
  clinic: {
    name: string; timezone: string; knowledge: string; owner_summary_phone: string;
    escalation_contact: string; chase_reply_to: string; chase_cadence: any; services: any[]; hours: Record<string, any>;
  };
  connections: {
    invoice_source: string | null; payment_provider: string | null;
    email_domain: string | null; email_domain_status: string | null; chasing_paused: boolean;
  };
};
const DEFAULT_CADENCE = { stage1: 1, stage2: 7, stage3: 21, cooldown: 6 };
const PAY_FIELDS: Record<string, [string, string][]> = {
  payfast: [['merchant_id', 'Merchant ID'], ['merchant_key', 'Merchant key'], ['passphrase', 'Passphrase']],
  paystack: [['secret_key', 'Secret key (sk_…)']],
  stripe: [['secret_key', 'Secret key (sk_…)']],
  paypal: [['client_id', 'Client ID'], ['secret', 'Secret']],
  link: [['url', 'Payment page URL']],
};
const DAYS: [string, string][] = [['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday']];
type HourRow = { open: string; close: string; enabled: boolean };
function hydrateHours(h: Record<string, any>): Record<string, HourRow> {
  const out: Record<string, HourRow> = {};
  for (const [d] of DAYS) { const v = h?.[d]; out[d] = v && v[0] ? { open: v[0][0], close: v[0][1], enabled: true } : { open: '09:00', close: '17:00', enabled: false }; }
  return out;
}
function buildHours(state: Record<string, HourRow>): Record<string, [string, string][]> {
  const out: Record<string, [string, string][]> = {};
  for (const [d] of DAYS) { const v = state[d]; if (v?.enabled) out[d] = [[v.open, v.close]]; }
  return out;
}

export function Settings() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [form, setForm] = useState<any>(null);
  const [cadence, setCadence] = useState(DEFAULT_CADENCE);
  const [services, setServices] = useState<any[]>([]);
  const [hours, setHours] = useState<Record<string, HourRow>>({});
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // connections
  const [sheetUrl, setSheetUrl] = useState('');
  const [payProvider, setPayProvider] = useState('payfast');
  const [payFields, setPayFields] = useState<Record<string, string>>({});
  const [connBusy, setConnBusy] = useState(false);
  const [connMsg, setConnMsg] = useState('');

  function load() {
    api<SettingsData>('/api/settings').then((d) => {
      setS(d);
      setForm({ name: d.clinic.name, timezone: d.clinic.timezone, owner_summary_phone: d.clinic.owner_summary_phone, escalation_contact: d.clinic.escalation_contact, knowledge: d.clinic.knowledge, chase_reply_to: d.clinic.chase_reply_to });
      setCadence({ ...DEFAULT_CADENCE, ...(d.clinic.chase_cadence || {}) });
      setServices(Array.isArray(d.clinic.services) ? d.clinic.services.map((x: any) => ({ ...x })) : []);
      setHours(hydrateHours(d.clinic.hours || {}));
    }).catch((e) => setErr(e.message));
  }
  useEffect(load, []);

  if (err) return <div className="banner error">{err}</div>;
  if (!s || !form) return <div className="empty">Loading…</div>;

  const canEdit = s.role === 'owner' || s.role === 'admin';
  const f = (k: string, v: string) => setForm((p: any) => ({ ...p, [k]: v }));
  const conn = s.connections;

  async function save() {
    setSaving(true); setSaved(false);
    try {
      const cleanServices = services.filter((sv) => (sv.service || sv.name || '').trim())
        .map((sv) => ({ service: (sv.service || sv.name || '').trim(), duration_min: Number(sv.duration_min) || 0, price_zar: Number(sv.price_zar) || 0, ...(sv.prep ? { prep: sv.prep } : {}) }));
      await api('/api/settings', { method: 'POST', body: JSON.stringify({ ...form, chase_cadence: cadence, services_json: cleanServices, hours_json: buildHours(hours) }) });
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    }
    catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  }
  async function connectAccounting(provider: string) {
    setConnBusy(true); setConnMsg('');
    try { const r = await api<{ url: string }>(`/api/connect/${provider}/start`); window.location.href = r.url; }
    catch (e: any) { setConnMsg(e.message); setConnBusy(false); }
  }
  async function connectSheet() {
    setConnBusy(true); setConnMsg('');
    try { await api('/api/connect/gsheet', { method: 'POST', body: JSON.stringify({ sheet_url: sheetUrl }) }); setConnMsg('Google Sheet connected.'); setSheetUrl(''); load(); }
    catch (e: any) { setConnMsg(e.message); } finally { setConnBusy(false); }
  }
  async function savePayment() {
    setConnBusy(true); setConnMsg('');
    try { await api('/api/connect/payment', { method: 'POST', body: JSON.stringify({ provider: payProvider, config: payFields }) }); setConnMsg(`Payment provider set to ${payProvider}.`); setPayFields({}); load(); }
    catch (e: any) { setConnMsg(e.message); } finally { setConnBusy(false); }
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
          <div className="field"><label>Reply-to email (for chase emails)</label><input value={form.chase_reply_to} onChange={(e) => f('chase_reply_to', e.target.value)} disabled={!canEdit} placeholder="accounts@yourclinic.co.za" /></div>
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

      {/* Connections */}
      <div className="panel" style={{ margin: '18px 0' }}>
        <div className="panel-head"><h2>Connections</h2>{connMsg && <span className="count" style={{ color: 'var(--teal)' }}>{connMsg}</span>}</div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 22 }}>

          <div>
            <div className="conn-row">
              <div><div className="conn-title">Invoice source</div><div className="conn-sub">Where Remi pulls invoices to chase</div></div>
              <span className={`badge ${conn.invoice_source ? 'b-green' : 'b-grey'}`} style={{ textTransform: 'capitalize' }}>{conn.invoice_source ?? 'Not connected'}</span>
            </div>
            {canEdit && (
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button className="btn" disabled={connBusy} onClick={() => connectAccounting('xero')}>Connect Xero</button>
                <button className="btn" disabled={connBusy} onClick={() => connectAccounting('quickbooks')}>QuickBooks</button>
                <button className="btn" disabled={connBusy} onClick={() => connectAccounting('sage')}>Sage</button>
              </div>
            )}
            {canEdit && (
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <input className="conn-input" placeholder="…or paste a published Google Sheet CSV URL" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} />
                <button className="btn" disabled={connBusy || !sheetUrl} onClick={connectSheet}>Connect sheet</button>
              </div>
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 20 }}>
            <div className="conn-row">
              <div><div className="conn-title">Payment provider</div><div className="conn-sub">So invoices carry a "Pay now" link</div></div>
              <span className={`badge ${conn.payment_provider ? 'b-green' : 'b-grey'}`} style={{ textTransform: 'capitalize' }}>{conn.payment_provider ?? 'Not set up'}</span>
            </div>
            {canEdit && (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <div className="field" style={{ minWidth: 150 }}>
                    <label>Provider</label>
                    <select className="conn-input" value={payProvider} onChange={(e) => { setPayProvider(e.target.value); setPayFields({}); }}>
                      {Object.keys(PAY_FIELDS).map((p) => <option key={p} value={p} style={{ textTransform: 'capitalize' }}>{p}</option>)}
                    </select>
                  </div>
                  {PAY_FIELDS[payProvider].map(([k, lbl]) => (
                    <div className="field" key={k} style={{ minWidth: 150, flex: 1 }}>
                      <label>{lbl}</label>
                      <input className="conn-input" value={payFields[k] ?? ''} onChange={(e) => setPayFields({ ...payFields, [k]: e.target.value })} />
                    </div>
                  ))}
                </div>
                <button className="btn primary" style={{ marginTop: 12 }} disabled={connBusy} onClick={savePayment}>Save payment provider</button>
              </div>
            )}
          </div>

          <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 20 }}>
            <div className="conn-row">
              <div><div className="conn-title">Email sending domain</div><div className="conn-sub">White-label so chases come from your domain</div></div>
              <span className={`badge ${conn.email_domain ? (conn.email_domain_status === 'verified' ? 'b-green' : 'b-amber') : 'b-grey'}`}>{conn.email_domain ? `${conn.email_domain} · ${conn.email_domain_status || 'pending'}` : 'Send-on-behalf'}</span>
            </div>
            <div className="conn-sub" style={{ marginTop: 10 }}>Branded email-domain setup is handled during onboarding. Until then, chases send on your behalf with your reply-to address above.</div>
          </div>

        </div>
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-head"><h2>Services</h2>{canEdit && <button className="btn sm" onClick={() => setServices([...services, { service: '', duration_min: 30, price_zar: 0 }])}>+ Add service</button>}</div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {services.length === 0 && <div className="faint">No services yet.</div>}
          {services.map((sv, i) => (
            <div key={i} className="svc-row">
              <input className="conn-input" placeholder="Service name" value={sv.service ?? sv.name ?? ''} onChange={(e) => setServices(services.map((x, j) => j === i ? { ...x, service: e.target.value } : x))} disabled={!canEdit} />
              <input className="conn-input" type="number" placeholder="min" style={{ maxWidth: 90 }} value={sv.duration_min ?? ''} onChange={(e) => setServices(services.map((x, j) => j === i ? { ...x, duration_min: e.target.value } : x))} disabled={!canEdit} />
              <input className="conn-input" type="number" placeholder="R price" style={{ maxWidth: 110 }} value={sv.price_zar ?? ''} onChange={(e) => setServices(services.map((x, j) => j === i ? { ...x, price_zar: e.target.value } : x))} disabled={!canEdit} />
              {canEdit && <button className="btn sm danger" onClick={() => setServices(services.filter((_, j) => j !== i))}>Remove</button>}
            </div>
          ))}
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-head"><h2>Opening hours</h2></div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {DAYS.map(([d, label]) => {
            const h = hours[d] ?? { open: '09:00', close: '17:00', enabled: false };
            return (
              <div key={d} className="hours-row">
                <label className="hours-day"><input type="checkbox" checked={h.enabled} disabled={!canEdit} onChange={(e) => setHours({ ...hours, [d]: { ...h, enabled: e.target.checked } })} /> {label}</label>
                {h.enabled ? (
                  <div className="hours-times">
                    <input className="conn-input" type="time" value={h.open} disabled={!canEdit} onChange={(e) => setHours({ ...hours, [d]: { ...h, open: e.target.value } })} />
                    <span className="faint">to</span>
                    <input className="conn-input" type="time" value={h.close} disabled={!canEdit} onChange={(e) => setHours({ ...hours, [d]: { ...h, close: e.target.value } })} />
                  </div>
                ) : <span className="faint">Closed</span>}
              </div>
            );
          })}
        </div>
      </div>

      {canEdit && <div className="save-row"><button className="btn primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</button>{saved && <span className="saved">Saved ✓</span>}</div>}
    </>
  );
}
