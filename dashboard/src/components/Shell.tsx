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

type Me = { user: { email: string; role: string }; clinic: { name: string } | null };

const NAV = [
  { key: 'assistant', label: 'Ask Remi', icon: 'assistant', title: 'Ask Remi', sub: 'Your AI office manager', ready: true, lead: true },
  { key: 'today', label: 'Today', icon: 'today', title: 'Today', sub: "What Remi is handling right now", ready: true },
  { key: 'inbox', label: 'Inbox', icon: 'inbox', title: 'Inbox', sub: 'Calls & messages Remi handled', ready: true },
  { key: 'bookings', label: 'Bookings', icon: 'bookings', title: 'Bookings', sub: 'Appointments Remi booked', ready: true },
  { key: 'getpaid', label: 'Get Paid', icon: 'getpaid', title: 'Get Paid', sub: 'Invoices Remi is chasing', ready: true },
  { key: 'insights', label: 'Insights', icon: 'insights', title: 'Insights', sub: 'Last 30 days', ready: true },
  { key: 'customers', label: 'Customers', icon: 'customers', title: 'Customers', sub: 'Everyone Remi has spoken to', ready: true },
  { key: 'settings', label: 'Settings', icon: 'settings', title: 'Settings', sub: '', ready: false },
];

export function Shell({ onSignOut }: { onSignOut: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState('assistant');
  const [err, setErr] = useState('');

  useEffect(() => { api<Me>('/api/me').then(setMe).catch((e) => setErr(e.message)); }, []);
  const active = NAV.find((n) => n.key === view)!;
  const initial = (me?.user?.email ?? '?').charAt(0).toUpperCase();

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
          {NAV.map((n, i) => (
            <div key={n.key} style={{ display: 'contents' }}>
              {i === 1 && <div className="nav-sec">Operations</div>}
              <button className={`nav-item ${view === n.key ? 'active' : ''} ${n.lead ? 'lead' : ''}`}
                onClick={() => n.ready && setView(n.key)} disabled={!n.ready} title={n.ready ? '' : 'Coming soon'}>
                <span className="ico"><Icon name={n.icon} size={18} /></span>
                <span className="label">{n.label}</span>
                {!n.ready && <span className="soon">soon</span>}
              </button>
            </div>
          ))}
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
        </div>
      </div>
    </div>
  );
}
