import { useEffect, useState } from 'react';
import { api } from '../lib/api';

type Task = { id: string; title: string; note: string | null; assignee: string | null; status: string; source: string; created_at: string };
type Expense = { id: string; amount_zar: number; description: string | null; category: string | null; logged_by: string | null; created_at: string };
type Data = { role: string; tasks: Task[]; expenses: Expense[]; expenses_week_total: number };

const SOURCE_LABEL: Record<string, string> = {
  'whatsapp-client': 'message from client', 'whatsapp-staff': 'from staff', 'copilot': 'Ask Remi', 'dashboard': 'added here',
};

export function Tasks() {
  const [d, setD] = useState<Data | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [newTask, setNewTask] = useState('');
  const [exp, setExp] = useState({ amount_zar: '', description: '' });

  function load() { api<Data>('/api/tasks').then(setD).catch((e) => setErr(e.message)); }
  useEffect(load, []);

  if (err) return <div className="banner error">{err}</div>;
  if (!d) return <div className="empty">Loading…</div>;
  const canEdit = d.role === 'owner' || d.role === 'admin';
  const open = d.tasks.filter((t) => t.status === 'open');
  const done = d.tasks.filter((t) => t.status === 'done').slice(0, 10);

  async function addTask() {
    if (!newTask.trim()) return;
    setBusy(true);
    try { await api('/api/tasks', { method: 'POST', body: JSON.stringify({ title: newTask.trim() }) }); setNewTask(''); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function complete(id: string) {
    setBusy(true);
    try { await api(`/api/tasks/${id}/complete`, { method: 'POST' }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  async function addExpense() {
    const amt = Number(exp.amount_zar);
    if (!amt) return;
    setBusy(true);
    try { await api('/api/expenses', { method: 'POST', body: JSON.stringify({ amount_zar: amt, description: exp.description }) }); setExp({ amount_zar: '', description: '' }); load(); }
    catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* To-do / messages */}
      <div className="panel">
        <div className="panel-head"><h2>To-do &amp; messages</h2><span className="count">{open.length} open</span></div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {canEdit && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="conn-input" placeholder="Add a task…" value={newTask} onChange={(e) => setNewTask(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTask()} />
              <button className="btn primary" disabled={busy || !newTask.trim()} onClick={addTask}>Add</button>
            </div>
          )}
          {open.length === 0 && <div className="faint">Nothing on the list — all clear. ✨</div>}
          {open.map((t) => (
            <div key={t.id} className="conn-row">
              <div>
                <div className="conn-title">{t.title}</div>
                {t.note && <div className="conn-sub" style={{ whiteSpace: 'pre-wrap' }}>{t.note}</div>}
                <div className="conn-sub">{SOURCE_LABEL[t.source] ?? t.source}</div>
              </div>
              {canEdit && <button className="btn sm primary" disabled={busy} onClick={() => complete(t.id)}>Done</button>}
            </div>
          ))}
          {done.length > 0 && (
            <>
              <div className="conn-sub" style={{ marginTop: 8 }}>Recently done</div>
              {done.map((t) => (
                <div key={t.id} className="conn-row" style={{ opacity: 0.55 }}>
                  <div className="conn-title" style={{ textDecoration: 'line-through' }}>{t.title}</div>
                  <span className="badge b-green">Done</span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Expenses */}
      <div className="panel">
        <div className="panel-head"><h2>Expenses this week</h2><span className="count">R{d.expenses_week_total.toFixed(2)}</span></div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {canEdit && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="conn-input" type="number" placeholder="R amount" style={{ maxWidth: 130 }} value={exp.amount_zar} onChange={(e) => setExp({ ...exp, amount_zar: e.target.value })} />
              <input className="conn-input" placeholder="What for?" value={exp.description} onChange={(e) => setExp({ ...exp, description: e.target.value })} />
              <button className="btn primary" disabled={busy || !exp.amount_zar} onClick={addExpense}>Log</button>
            </div>
          )}
          {d.expenses.length === 0 && <div className="faint">No expenses logged this week.</div>}
          {d.expenses.map((e) => (
            <div key={e.id} className="conn-row">
              <div>
                <div className="conn-title">R{Number(e.amount_zar).toFixed(2)} <span className="conn-sub">{e.description || ''}</span></div>
                <div className="conn-sub">{e.logged_by || ''}{e.category ? ` · ${e.category}` : ''}</div>
              </div>
            </div>
          ))}
          <div className="conn-sub" style={{ marginTop: 6 }}>Staff can log expenses by texting Remi (e.g. "log R450 gloves").</div>
        </div>
      </div>
    </div>
  );
}
