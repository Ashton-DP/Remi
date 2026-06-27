import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Customer = {
  id: string; name?: string; phone?: string; email?: string;
  consent_at?: string; created_at?: string;
  notes?: string; preferences?: string; allergies?: string;
  tags?: string[]; birthday?: string; anniversary?: string;
};
type Package = {
  id: string; name: string; sessions_total: number; sessions_used: number;
  expires_at?: string; created_at: string;
  clients?: { name?: string; phone?: string };
};
type Membership = {
  id: string; plan_name: string; status: string; amount_zar?: number; billing_interval?: string;
  provider?: string; renews_at?: string; created_at: string;
  clients?: { name?: string; phone?: string };
};

const date = (s?: string) =>
  s ? new Date(s).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const mmdd = (s?: string) => (s ? s.slice(5).replace('-', '/') : null);

type Tab = 'clients' | 'packages' | 'memberships';

export function Customers() {
  const [tab, setTab] = useState<Tab>('clients');
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [packages, setPackages] = useState<Package[] | null>(null);
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [editing, setEditing] = useState<Partial<Customer>>({});
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Membership signup form
  const [showNewMember, setShowNewMember] = useState(false);
  const [memberForm, setMemberForm] = useState({ client_id: '', plan_name: '', amount_zar: '', interval: 'month' });
  const [signupLink, setSignupLink] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ customers: Customer[] }>('/api/customers')
      .then((d) => setCustomers(d.customers))
      .catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    if (tab === 'packages' && !packages) {
      api<{ packages: Package[] }>('/api/packages').then((d) => setPackages(d.packages)).catch((e) => setErr(e.message));
    }
    if (tab === 'memberships' && !memberships) {
      api<{ memberships: Membership[] }>('/api/memberships').then((d) => setMemberships(d.memberships)).catch((e) => setErr(e.message));
    }
  }, [tab]);

  async function openProfile(c: Customer) {
    try {
      const full = await api<{ customer: Customer }>(`/api/customers/${c.id}`);
      setSelected(full.customer);
      setEditing({
        notes: full.customer.notes ?? '',
        preferences: full.customer.preferences ?? '',
        allergies: full.customer.allergies ?? '',
        birthday: full.customer.birthday ?? '',
        anniversary: full.customer.anniversary ?? '',
        tags: full.customer.tags ?? [],
      });
    } catch {
      setSelected(c);
      setEditing({ notes: '', preferences: '', allergies: '', birthday: '', anniversary: '', tags: [] });
    }
  }

  async function saveProfile() {
    if (!selected) return;
    setSaving(true);
    try {
      const updated = await api<{ customer: Customer }>(`/api/customers/${selected.id}`, {
        method: 'PATCH',
        body: JSON.stringify(editing),
      });
      setCustomers((prev) => prev?.map((c) => c.id === selected.id ? { ...c, ...updated.customer } : c) ?? null);
      setSelected(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function createMembership() {
    setBusy(true);
    setErr('');
    try {
      const out = await api<{ membership: Membership; signup_url: string }>('/api/memberships', {
        method: 'POST',
        body: JSON.stringify({
          client_id: memberForm.client_id,
          plan_name: memberForm.plan_name,
          amount_zar: Number(memberForm.amount_zar),
          interval: memberForm.interval,
        }),
      });
      setMemberships((prev) => [out.membership, ...(prev ?? [])]);
      setSignupLink(out.signup_url);
      setMemberForm({ client_id: '', plan_name: '', amount_zar: '', interval: 'month' });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelMembership(id: string) {
    if (!confirm('Cancel this membership at the end of the current period?')) return;
    try {
      const out = await api<{ membership: Membership }>(`/api/memberships/${id}/cancel`, { method: 'POST' });
      setMemberships((prev) => prev?.map((m) => m.id === id ? { ...m, ...out.membership } : m) ?? null);
    } catch (e: any) {
      setErr(e.message);
    }
  }

  if (err && !showNewMember) return <div className="banner error">{err}</div>;

  const statusBadge = (s: string) => {
    const cls = s === 'active' ? 'b-green'
      : s === 'paused' || s === 'pending' ? 'b-amber'
      : s === 'past_due' ? 'b-red'
      : 'b-grey';
    return <span className={`badge ${cls}`}>{s}</span>;
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Clients</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {customers && tab === 'clients' && <span className="count">{customers.length}</span>}
          {(['clients', 'packages', 'memberships'] as Tab[]).map((t) => (
            <button
              key={t}
              className={`btn sm${tab === t ? ' primary' : ''}`}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {tab === 'clients' && (
        !customers ? (
          <div className="empty">Loading…</div>
        ) : customers.length === 0 ? (
          <div className="empty">No clients yet. They'll appear here as Remi handles enquiries and bookings.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Phone / Email</th><th>Tags</th><th>Birthday</th><th>Consent</th><th>Added</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => openProfile(c)}>
                  <td><span className="primary">{c.name || '—'}</span></td>
                  <td>{c.phone || c.email || '—'}</td>
                  <td>
                    {(c.tags ?? []).map((t) => (
                      <span key={t} className="badge b-blue" style={{ marginRight: 4 }}>{t}</span>
                    ))}
                  </td>
                  <td>{mmdd(c.birthday) ?? '—'}</td>
                  <td>
                    {c.consent_at
                      ? <span className="badge b-green">Opted in</span>
                      : <span className="badge b-grey">None</span>}
                  </td>
                  <td>{date(c.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {tab === 'packages' && (
        !packages ? (
          <div className="empty">Loading…</div>
        ) : packages.length === 0 ? (
          <div className="empty">No packages yet. Ask Remi to record one, or create one via the API.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Client</th><th>Package</th><th>Sessions</th><th>Expires</th><th>Created</th></tr>
            </thead>
            <tbody>
              {packages.map((p) => {
                const remaining = p.sessions_total - p.sessions_used;
                const low = remaining <= 2;
                return (
                  <tr key={p.id}>
                    <td><span className="primary">{p.clients?.name || p.clients?.phone || '—'}</span></td>
                    <td>{p.name}</td>
                    <td>
                      <span className={`badge ${low ? 'b-amber' : 'b-green'}`}>
                        {remaining} / {p.sessions_total} left
                      </span>
                    </td>
                    <td>{p.expires_at ? date(p.expires_at) : 'No expiry'}</td>
                    <td>{date(p.created_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )
      )}

      {tab === 'memberships' && (
        <>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn sm primary" onClick={() => { setShowNewMember(true); setSignupLink(''); setErr(''); }}>
              + New membership
            </button>
          </div>
          {!memberships ? (
            <div className="empty">Loading…</div>
          ) : memberships.length === 0 ? (
            <div className="empty">No memberships yet. Click “New membership” to set up recurring billing for a client.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Client</th><th>Plan</th><th>Amount</th><th>Status</th><th>Renews</th><th></th></tr>
              </thead>
              <tbody>
                {memberships.map((m) => (
                  <tr key={m.id}>
                    <td><span className="primary">{m.clients?.name || m.clients?.phone || '—'}</span></td>
                    <td>{m.plan_name}{m.provider && <span className="faint" style={{ marginLeft: 6, fontSize: 11 }}>via {m.provider}</span>}</td>
                    <td>{m.amount_zar ? `R${m.amount_zar}/${m.billing_interval === 'year' ? 'yr' : 'mo'}` : '—'}</td>
                    <td>{statusBadge(m.status)}</td>
                    <td>{m.renews_at ? date(m.renews_at) : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      {m.status === 'pending' && (
                        <button
                          className="btn sm"
                          onClick={() => { navigator.clipboard?.writeText(`${location.origin}/membership/${m.id}/start`); }}
                          title="Copy signup link"
                        >Copy link</button>
                      )}
                      {(m.status === 'active' || m.status === 'past_due' || m.status === 'paused') && (
                        <button className="btn sm danger" onClick={() => cancelMembership(m.id)}>Cancel</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {selected && (
        <div className="modal-overlay" onClick={() => setSelected(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{selected.name || selected.phone || 'Client profile'}</h3>
            <p style={{ color: 'var(--muted)', marginBottom: 16 }}>
              {selected.phone}{selected.email ? ` · ${selected.email}` : ''}
            </p>

            {(
              [
                { label: 'Notes', key: 'notes' as const, multiline: true },
                { label: 'Preferences', key: 'preferences' as const, multiline: false },
                { label: 'Allergies / contraindications', key: 'allergies' as const, multiline: false },
              ] as const
            ).map(({ label, key, multiline }) => (
              <div className="field" key={key}>
                <label>{label}</label>
                {multiline ? (
                  <textarea
                    rows={3}
                    value={(editing[key] as string) ?? ''}
                    onChange={(e) => setEditing((p) => ({ ...p, [key]: e.target.value }))}
                  />
                ) : (
                  <input
                    value={(editing[key] as string) ?? ''}
                    onChange={(e) => setEditing((p) => ({ ...p, [key]: e.target.value }))}
                  />
                )}
              </div>
            ))}

            <div className="field">
              <label>Tags (comma-separated)</label>
              <input
                value={(editing.tags ?? []).join(', ')}
                onChange={(e) =>
                  setEditing((p) => ({
                    ...p,
                    tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean),
                  }))
                }
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field">
                <label>Birthday</label>
                <input
                  type="date"
                  value={(editing.birthday as string) ?? ''}
                  onChange={(e) => setEditing((p) => ({ ...p, birthday: e.target.value }))}
                />
              </div>
              <div className="field">
                <label>Anniversary</label>
                <input
                  type="date"
                  value={(editing.anniversary as string) ?? ''}
                  onChange={(e) => setEditing((p) => ({ ...p, anniversary: e.target.value }))}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button className="btn sm" onClick={() => setSelected(null)}>Cancel</button>
              <button className="btn sm primary" onClick={saveProfile} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showNewMember && (
        <div className="modal-overlay" onClick={() => setShowNewMember(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>New membership</h3>
            {err && <div className="banner error">{err}</div>}

            {signupLink ? (
              <>
                <p style={{ color: 'var(--muted)' }}>
                  Membership created. Send this signup link to the client — they'll enter their card and it activates automatically:
                </p>
                <div className="field">
                  <input readOnly value={signupLink} onFocus={(e) => e.currentTarget.select()} />
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn sm" onClick={() => navigator.clipboard?.writeText(signupLink)}>Copy link</button>
                  <button className="btn sm primary" onClick={() => setShowNewMember(false)}>Done</button>
                </div>
              </>
            ) : (
              <>
                <div className="field">
                  <label>Client</label>
                  <select value={memberForm.client_id} onChange={(e) => setMemberForm((f) => ({ ...f, client_id: e.target.value }))}>
                    <option value="">Select a client…</option>
                    {(customers ?? []).map((c) => (
                      <option key={c.id} value={c.id}>{c.name || c.phone || c.email || c.id}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Plan name</label>
                  <input
                    placeholder="e.g. Monthly Wellness Plan"
                    value={memberForm.plan_name}
                    onChange={(e) => setMemberForm((f) => ({ ...f, plan_name: e.target.value }))}
                  />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="field">
                    <label>Amount (R)</label>
                    <input
                      type="number" min="1" placeholder="500"
                      value={memberForm.amount_zar}
                      onChange={(e) => setMemberForm((f) => ({ ...f, amount_zar: e.target.value }))}
                    />
                  </div>
                  <div className="field">
                    <label>Billed every</label>
                    <select value={memberForm.interval} onChange={(e) => setMemberForm((f) => ({ ...f, interval: e.target.value }))}>
                      <option value="month">Month</option>
                      <option value="year">Year</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
                  <button className="btn sm" onClick={() => setShowNewMember(false)}>Cancel</button>
                  <button
                    className="btn sm primary"
                    disabled={busy || !memberForm.client_id || !memberForm.plan_name || !(Number(memberForm.amount_zar) > 0)}
                    onClick={createMembership}
                  >
                    {busy ? 'Creating…' : 'Create & get link'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
