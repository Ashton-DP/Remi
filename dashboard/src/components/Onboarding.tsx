import { useState } from 'react';
import { api } from '../lib/api';

const DAYS: [string, string][] = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'],
  ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];

type HourRow = { open: string; close: string; enabled: boolean };
type Service = { service: string; duration_min: number; price_zar: number; prep: string };

function hydrateHours(): Record<string, HourRow> {
  const out: Record<string, HourRow> = {};
  for (const [d] of DAYS) out[d] = { open: '09:00', close: '17:00', enabled: !['sat', 'sun'].includes(d) };
  return out;
}
function buildHours(state: Record<string, HourRow>) {
  const out: Record<string, [string, string][]> = {};
  for (const [d] of DAYS) if (state[d]?.enabled) out[d] = [[state[d].open, state[d].close]];
  return out;
}

const STEPS = [
  { num: 1, label: 'Your clinic' },
  { num: 2, label: 'Services' },
  { num: 3, label: 'Hours' },
  { num: 4, label: 'Knowledge' },
  { num: 5, label: 'Calendar' },
  { num: 6, label: 'WhatsApp' },
];

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Step 1 — clinic basics
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState('Africa/Johannesburg');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [escalation] = useState('');

  // Step 2 — services
  const [services, setServices] = useState<Service[]>([
    { service: '', duration_min: 30, price_zar: 0, prep: '' },
  ]);

  // Step 3 — hours
  const [hours, setHours] = useState<Record<string, HourRow>>(hydrateHours());

  // Step 4 — knowledge
  const [knowledge, setKnowledge] = useState('');

  // Step 5 — calendar
  const [calendarId, setCalendarId] = useState('');

  // Step 6 — WhatsApp
  const [waNumber, setWaNumber] = useState('');
  const [waHasAccount, setWaHasAccount] = useState<boolean | null>(null);
  const [waSubmitted, setWaSubmitted] = useState(false);

  async function next() {
    setErr('');
    if (step === 1 && !name.trim()) { setErr('Please enter your clinic name.'); return; }
    if (step < STEPS.length) { setStep(step + 1); return; }
    // Final step — save everything + mark complete
    await finish();
  }

  async function finish() {
    setBusy(true);
    try {
      const cleanServices = services
        .filter((s) => s.service.trim())
        .map((s) => ({ service: s.service.trim(), duration_min: Number(s.duration_min) || 30, price_zar: Number(s.price_zar) || 0, ...(s.prep ? { prep: s.prep } : {}) }));

      await api('/api/onboarding/complete', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          timezone,
          owner_summary_phone: ownerPhone,
          escalation_contact: escalation || ownerPhone,
          knowledge: knowledge.trim(),
          google_calendar_id: calendarId.trim(),
          services_json: cleanServices,
          hours_json: buildHours(hours),
        }),
      });
      onComplete();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitWaNumber() {
    if (!waNumber.trim()) { setErr('Please enter your WhatsApp number.'); return; }
    setBusy(true);
    setErr('');
    try {
      await api('/api/onboarding/whatsapp', { method: 'POST', body: JSON.stringify({ number: waNumber.trim() }) });
      setWaSubmitted(true);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  const progress = (step / STEPS.length) * 100;

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card">
        {/* Header */}
        <div className="onb-header">
          <div className="onb-logo">R</div>
          <div>
            <div className="onb-title">Welcome to Remi</div>
            <div className="onb-sub">Let's get your clinic set up — takes about 5 minutes</div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="onb-progress-track">
          <div className="onb-progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="onb-steps">
          {STEPS.map((s) => (
            <div key={s.num} className={`onb-step ${step === s.num ? 'active' : step > s.num ? 'done' : ''}`}>
              <div className="onb-step-dot">{step > s.num ? '✓' : s.num}</div>
              <div className="onb-step-label">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="onb-body">
          {step === 1 && (
            <>
              <h2>Your clinic details</h2>
              <p className="onb-hint">This is what Remi introduces itself as on every call and message.</p>
              <div className="onb-field">
                <label>Clinic name *</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aesthetics by Remi" />
              </div>
              <div className="onb-field">
                <label>Timezone</label>
                <select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                  <option value="Africa/Johannesburg">South Africa (SAST)</option>
                  <option value="Africa/Lagos">Nigeria (WAT)</option>
                  <option value="Africa/Nairobi">Kenya (EAT)</option>
                  <option value="UTC">UTC</option>
                </select>
              </div>
              <div className="onb-field">
                <label>Your WhatsApp number (for Remi alerts)</label>
                <input value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} placeholder="+27821234567" />
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2>Your services</h2>
              <p className="onb-hint">Remi uses these to answer pricing questions and book the right slot length.</p>
              {services.map((sv, i) => (
                <div key={i} className="onb-svc-row">
                  <input
                    className="onb-svc-name"
                    placeholder="Service name"
                    value={sv.service}
                    onChange={(e) => setServices(services.map((x, j) => j === i ? { ...x, service: e.target.value } : x))}
                  />
                  <input
                    type="number"
                    className="onb-svc-num"
                    placeholder="min"
                    value={sv.duration_min || ''}
                    onChange={(e) => setServices(services.map((x, j) => j === i ? { ...x, duration_min: +e.target.value } : x))}
                  />
                  <input
                    type="number"
                    className="onb-svc-num"
                    placeholder="R price"
                    value={sv.price_zar || ''}
                    onChange={(e) => setServices(services.map((x, j) => j === i ? { ...x, price_zar: +e.target.value } : x))}
                  />
                  <button className="onb-remove" onClick={() => setServices(services.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button className="onb-add-btn" onClick={() => setServices([...services, { service: '', duration_min: 30, price_zar: 0, prep: '' }])}>
                + Add service
              </button>
            </>
          )}

          {step === 3 && (
            <>
              <h2>Opening hours</h2>
              <p className="onb-hint">Remi tells callers when you're open and only books within these times.</p>
              {DAYS.map(([d, label]) => {
                const h = hours[d];
                return (
                  <div key={d} className="onb-hours-row">
                    <label className="onb-hours-day">
                      <input type="checkbox" checked={h.enabled} onChange={(e) => setHours({ ...hours, [d]: { ...h, enabled: e.target.checked } })} />
                      {label}
                    </label>
                    {h.enabled ? (
                      <div className="onb-hours-times">
                        <input type="time" value={h.open} onChange={(e) => setHours({ ...hours, [d]: { ...h, open: e.target.value } })} />
                        <span>to</span>
                        <input type="time" value={h.close} onChange={(e) => setHours({ ...hours, [d]: { ...h, close: e.target.value } })} />
                      </div>
                    ) : <span className="onb-closed">Closed</span>}
                  </div>
                );
              })}
            </>
          )}

          {step === 4 && (
            <>
              <h2>What Remi should know</h2>
              <p className="onb-hint">Location, parking, payment methods, policies, anything patients ask about. Write it like notes for a new receptionist.</p>
              <textarea
                className="onb-textarea"
                rows={8}
                value={knowledge}
                onChange={(e) => setKnowledge(e.target.value)}
                placeholder={`e.g.\nLocated at 14 Sandton Drive, Sandton. Free parking in basement.\nWe accept cash, card, EFT and Discovery/Momentum medical aid.\nClients must arrive 5 minutes early.\nNo refunds — results may vary per individual.`}
              />
            </>
          )}

          {step === 5 && (
            <>
              <h2>Connect your calendar</h2>
              <p className="onb-hint">Remi books appointments directly into your Google Calendar.</p>
              <div className="onb-cal-steps">
                <div className="onb-cal-step">
                  <div className="onb-cal-num">1</div>
                  <div>Open Google Calendar → your calendar's <strong>Settings and sharing</strong> → <strong>Share with specific people</strong> → add this email with <strong>"Make changes to events"</strong>:</div>
                </div>
                <div className="onb-cal-email">remi-calendar@remi-reception.iam.gserviceaccount.com</div>
                <div className="onb-cal-step">
                  <div className="onb-cal-num">2</div>
                  <div>Copy your <strong>Calendar ID</strong> from Settings → "Integrate calendar" and paste it below:</div>
                </div>
              </div>
              <div className="onb-field">
                <label>Google Calendar ID</label>
                <input value={calendarId} onChange={(e) => setCalendarId(e.target.value)} placeholder="yourname@gmail.com or …@group.calendar.google.com" />
              </div>
              <p className="onb-skip">You can skip this for now and connect later in Settings.</p>
            </>
          )}

          {step === 6 && (
            <>
              <h2>Connect WhatsApp</h2>
              <p className="onb-hint">Remi can answer your clinic's existing WhatsApp number — your patients keep messaging the number they already know.</p>

              {!waSubmitted ? (
                <>
                  <div className="onb-wa-choice">
                    <button
                      className={`onb-wa-btn ${waHasAccount === true ? 'selected' : ''}`}
                      onClick={() => setWaHasAccount(true)}
                    >
                      ✓ Yes, we already use WhatsApp Business
                    </button>
                    <button
                      className={`onb-wa-btn ${waHasAccount === false ? 'selected' : ''}`}
                      onClick={() => setWaHasAccount(false)}
                    >
                      ✕ We don't have WhatsApp Business yet
                    </button>
                  </div>

                  {waHasAccount === true && (
                    <div style={{ marginTop: 20 }}>
                      <div className="onb-field">
                        <label>Your WhatsApp Business number</label>
                        <input value={waNumber} onChange={(e) => setWaNumber(e.target.value)} placeholder="+27821234567" />
                      </div>
                      <p className="onb-hint">We'll connect it to your account within a few hours. You'll get a WhatsApp verification code — just forward it to us and we'll handle the rest.</p>
                      <button className="onb-wa-submit" onClick={submitWaNumber} disabled={busy}>
                        {busy ? 'Submitting…' : 'Submit number →'}
                      </button>
                    </div>
                  )}

                  {waHasAccount === false && (
                    <div className="onb-wa-noAccount">
                      <p>No problem — we'll set it up for you as part of your onboarding call. We'll reach out within 24 hours.</p>
                      <p className="onb-hint">In the meantime Remi will handle voice calls immediately.</p>
                    </div>
                  )}
                </>
              ) : (
                <div className="onb-wa-done">
                  <div className="onb-wa-check">✓</div>
                  <p><strong>Number submitted!</strong> We'll connect it within a few hours. Keep an eye out for a WhatsApp verification code — just forward it to us.</p>
                  <p className="onb-hint">Remi is already live on voice calls.</p>
                </div>
              )}
            </>
          )}

          {err && <div className="onb-error">{err}</div>}
        </div>

        {/* Footer */}
        <div className="onb-footer">
          {step > 1 && (
            <button className="onb-back" onClick={() => { setErr(''); setStep(step - 1); }}>← Back</button>
          )}
          <div style={{ flex: 1 }} />
          {step < STEPS.length && (
            <button className="onb-next" onClick={next} disabled={busy}>
              {step === 5 && !calendarId ? 'Skip for now →' : 'Continue →'}
            </button>
          )}
          {step === STEPS.length && (
            <button className="onb-finish" onClick={finish} disabled={busy}>
              {busy ? 'Setting up…' : 'Go to my dashboard →'}
            </button>
          )}
        </div>
        {step === STEPS.length && (
          <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--onb-muted, #94a3b8)', marginTop: 12 }}>
            By continuing you agree to our{' '}
            <a href="https://remireception.com/terms" target="_blank" rel="noreferrer" style={{ color: '#7c6fea' }}>Terms of Service</a>
            {' '}and{' '}
            <a href="https://remireception.com/privacy" target="_blank" rel="noreferrer" style={{ color: '#7c6fea' }}>Privacy Policy</a>.
          </p>
        )}
      </div>
    </div>
  );
}
