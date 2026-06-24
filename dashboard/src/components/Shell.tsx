import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Today } from '../screens/Today';

type Me = { user: { email: string; role: string }; clinic: { name: string } | null };

const NAV = [
  { key: 'today', label: 'Today', icon: '🏠', ready: true },
  { key: 'inbox', label: 'Inbox', icon: '💬', ready: false },
  { key: 'bookings', label: 'Bookings', icon: '📅', ready: false },
  { key: 'getpaid', label: 'Get Paid', icon: '💸', ready: false },
  { key: 'customers', label: 'Customers', icon: '👥', ready: false },
  { key: 'insights', label: 'Insights', icon: '📊', ready: false },
  { key: 'settings', label: 'Settings', icon: '⚙️', ready: false },
];

export function Shell({ onSignOut }: { onSignOut: () => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setView] = useState('today');
  const [err, setErr] = useState('');

  useEffect(() => { api<Me>('/api/me').then(setMe).catch((e) => setErr(e.message)); }, []);

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
          {NAV.map((n) => (
            <button
              key={n.key}
              className={`nav-item ${view === n.key ? 'active' : ''}`}
              onClick={() => n.ready && setView(n.key)}
              disabled={!n.ready}
              title={n.ready ? '' : 'Coming soon'}
            >
              <span className="nav-ico">{n.icon}</span>{n.label}
              {!n.ready && <span className="soon">soon</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="who">{me?.user?.email}<span className="role">{me?.user?.role}</span></div>
          <button className="signout" onClick={onSignOut}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        {err && <div className="banner error">{err}</div>}
        {view === 'today' && <Today />}
      </main>
    </div>
  );
}
