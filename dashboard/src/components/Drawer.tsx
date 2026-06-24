import type { ReactNode } from 'react';
import { Icon } from './icons';

export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label={title}>
        <div className="drawer-head">
          <h3>{title}</h3>
          <button className="x" onClick={onClose} aria-label="Close"><Icon name="close" size={18} /></button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}
