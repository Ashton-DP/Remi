import { useEffect, useState } from 'react';

type Mode = 'prompt' | 'ios' | null;

const DISMISSED_KEY = 'remi_install_dismissed';
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) && !(window.navigator as any).standalone;
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone;

export function InstallBanner() {
  const [mode, setMode] = useState<Mode>(null);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (isStandalone() || localStorage.getItem(DISMISSED_KEY)) return;

    if (isIos()) {
      setMode('ios');
      return;
    }

    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setMode('prompt');
    };
    window.addEventListener('beforeinstallprompt', handler as any);
    return () => window.removeEventListener('beforeinstallprompt', handler as any);
  }, []);

  function dismiss() {
    localStorage.setItem(DISMISSED_KEY, '1');
    setMode(null);
  }

  async function install() {
    if (!deferredPrompt) return;
    setInstalling(true);
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') setMode(null);
    setInstalling(false);
    setDeferredPrompt(null);
  }

  if (!mode) return null;

  return (
    <div className="install-banner">
      <div className="install-banner-icon">
        <div className="logo-dot" style={{ width: 32, height: 32, fontSize: 14 }}>R</div>
      </div>
      <div className="install-banner-body">
        <div className="install-banner-title">Add Remi to your home screen</div>
        {mode === 'ios' ? (
          <div className="install-banner-sub">
            Tap the <strong>Share</strong> icon in Safari, then choose <strong>Add to Home Screen</strong>.
          </div>
        ) : (
          <div className="install-banner-sub">One tap to open — no browser, no URL to remember.</div>
        )}
      </div>
      <div className="install-banner-actions">
        {mode === 'prompt' && (
          <button className="install-btn" onClick={install} disabled={installing}>
            {installing ? 'Installing…' : 'Install'}
          </button>
        )}
        <button className="install-dismiss" onClick={dismiss}>✕</button>
      </div>
    </div>
  );
}
