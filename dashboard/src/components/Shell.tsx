import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from './icons';
import { Assistant } from '../screens/Assistant';
import { Today } from '../screens/Today';
import { Inbox } from '../screens/Inbox';
import { Bookings } from '../screens/Bookings';
import { GetPaid } from '../screens/GetPaid';
import { Insights } from '../screens/Insights';
import { Customers } from '../screens/Customers';
import { Settings } from '../screens/Settings';

type Me = { user: { email: string; role: string }; clinic: { name: string } | null; plan?: string };

const NAV = [
  { key: 'assistant', label: 'Ask Remi', icon: 'assistant', title: 'Ask Remi', sub: 'Your AI office manager', ready: true, lead: true },
  { key: 'today', label: 'Today', icon: 'today', title: 'Today', sub: "What Remi is handling right now", ready: true },
  { key: 'inbox', label: 'Inbox', icon: 'inbox', title: 'Inbox', sub: 'Calls & messages Remi handled', ready: true },
  { key: 'bookings', label: 'Appointments', icon: 'bookings', title: 'Appointments', sub: 'Book, view and cancel appointments', ready: true },
  { key: 'getpaid', label: 'Get Paid', icon: 'getpaid', title: 'Get Paid', sub: 'Invoices Remi is chasing', ready: true },
  { key: 'insights', label: 'Insights', icon: 'insights', title: 'Insights', sub: 'Last 30 days', ready: true },
  { key: 'customers', label: 'Customers', icon: 'customers', title: 'Customers', sub: 'Everyone Remi has spoken to', ready: true },
  { key: 'settings', label: 'Settings', icon: 'settings', title: 'Settings', sub: 'Your business & how Remi runs', ready: true },
];

// Which screens each plan/tier opens. The tier the clinic bought decides the dashboard.
const PLAN_NAV: Record<string, string[]> = {
  basic: ['bookings', 'settings'],
  standard: ['assistant', 'today', 'inbox', 'bookings', 'customers', 'settings'],
  complete: NAV.map((n) => n.key),
};

export function Shell({ onSignOut }: { onSignOut: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState('assistant');
  const [err, setErr] = useState('');

  useEffect(() => { api<Me>('/api/me').then(setMe).catch((e) => setErr(e.message)); }, []);

  const plan = me?.plan ?? 'complete';
  const allowed = PLAN_NAV[plan] ?? PLAN_NAV.complete;
  const items = NAV.filter((n) => allowed.includes(n.key));
  useEffect(() => { if (me && !allowed.includes(view)) setView(items[0]?.key ?? 'bookings'); }, [me]);

  const lead = items.filter((n) => n.lead);
  const rest = items.filter((n) => !n.lead);
  const active = items.find((n) => n.key === view) ?? items[0] ?? NAV[0];
  const initial = (me?.user?.email ?? '?').charAt(0).toUpperCase();
  const renderItem = (n: typeof NAV[number]) => (
    <button key={n.key} className={`nav-item ${view === n.key ? 'active' : ''} ${n.lead ? 'lead' : ''}`} onClick={() => setView(n.key)}>
      <span className="ico"><Icon name={n.icon} size={18} /></span>
      <span className="label">{n.label}</span>
    </button>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="logo-dot">R</div>
          <div>
            <div className="brand-name">{me?.clinic?.name ?? 'Remi'}</div>
            <div className="brand-sub">Command Centre</div>
          </div>
        </div>
        <nav>
          {lead.map(renderItem)}
          {rest.length > 0 && lead.length > 0 && <div className="nav-sec">Operations</div>}
          {rest.map(renderItem)}
        </nav>
        <div className="sidebar-foot">
          <div className="who">
            <div className="avatar">{initial}</div>
            <div className="who-meta">
              <div className="who-email">{me?.user?.email ?? '…'}</div>
              <div className="who-role">{me?.user?.role ?? ''}</div>
            </div>
          </div>
          <button className="signout" onClick={onSignOut}><Icon name="signout" size={15} /> Sign out</button>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <div><h1 style={{ display: 'inline' }}>{active.title}</h1>{active.sub && <span className="sub">{active.sub}</span>}</div>
        </header>
        <div className="inner">
          {err && <div className="banner error">{err}</div>}
          {view === 'assistant' && <Assistant />}
          {view === 'today' && <Today />}
          {view === 'inbox' && <Inbox />}
          {view === 'bookings' && <Bookings />}
          {view === 'getpaid' && <GetPaid />}
          {view === 'insights' && <Insights />}
          {view === 'customers' && <Customers />}
          {view === 'settings' && <Settings />}
        </div>
      </div>
    </div>
  );
}
