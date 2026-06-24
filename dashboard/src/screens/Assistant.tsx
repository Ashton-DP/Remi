import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Icon } from '../components/icons';

type Msg = { role: 'user' | 'assistant'; content: string; hidden?: boolean };

const SUGGESTIONS = [
  'What does my day look like?',
  'Which invoices are overdue?',
  'How did we do this month?',
  'Pause invoice chasing',
];

const SR = typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;

export function Assistant() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const recogRef = useRef<any>(null);

  useEffect(() => {
    const opener: Msg = { role: 'user', content: 'Give me my brief for today.', hidden: true };
    setMsgs([opener]); setBusy(true);
    api<{ reply: string }>('/api/assistant', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: opener.content }] }) })
      .then(({ reply }) => { setMsgs([opener, { role: 'assistant', content: reply }]); })
      .catch(() => setMsgs([opener, { role: 'assistant', content: 'Sorry — I had trouble loading your brief. Try asking me something below.' }]))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);

  function say(text: string) {
    if (!speak || typeof window === 'undefined' || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/[*_#`]/g, ''));
    u.lang = 'en-ZA';
    window.speechSynthesis.speak(u);
  }

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const next = [...msgs, { role: 'user', content: text } as Msg];
    setMsgs(next); setInput(''); setBusy(true);
    try {
      const { reply } = await api<{ reply: string }>('/api/assistant', { method: 'POST', body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }) });
      setMsgs([...next, { role: 'assistant', content: reply }]); say(reply);
    } catch (e: any) {
      setMsgs([...next, { role: 'assistant', content: 'Sorry — I had trouble. ' + e.message }]);
    } finally { setBusy(false); }
  }

  function toggleMic() {
    if (!SR) return;
    if (listening) { recogRef.current?.stop(); setListening(false); return; }
    const r = new SR(); r.lang = 'en-ZA'; r.interimResults = false; r.maxAlternatives = 1;
    r.onresult = (e: any) => { const t = e.results[0][0].transcript; send(t); };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recogRef.current = r; setListening(true); r.start();
  }

  const visible = msgs.filter((m) => !m.hidden);

  return (
    <div className="copilot">
      <div className="copilot-msgs">
        {visible.map((m, i) => (
          <div key={i} className={`crow ${m.role}`}>
            {m.role === 'assistant' && <div className="cavatar"><Icon name="assistant" size={15} /></div>}
            <div className={`cmsg ${m.role}`}>{m.content}</div>
          </div>
        ))}
        {busy && (
          <div className="crow assistant">
            <div className="cavatar"><Icon name="assistant" size={15} /></div>
            <div className="cmsg assistant typing"><span /><span /><span /></div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {visible.length <= 1 && !busy && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)}>{s}</button>)}
        </div>
      )}

      <form className="copilot-input" onSubmit={(e) => { e.preventDefault(); send(input); }}>
        <button type="button" className={`voice-btn ${speak ? 'on' : ''}`} title={speak ? 'Spoken replies on' : 'Spoken replies off'} onClick={() => { setSpeak((v) => !v); if (speak) window.speechSynthesis?.cancel(); }} aria-label="Toggle spoken replies">
          <Icon name={speak ? 'volume' : 'volumeOff'} size={17} />
        </button>
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={listening ? 'Listening…' : 'Ask Remi anything, or tell it what to do…'} disabled={busy} />
        {SR && (
          <button type="button" className={`mic-btn ${listening ? 'live' : ''}`} onClick={toggleMic} disabled={busy} aria-label="Speak">
            <Icon name="mic" size={17} />
          </button>
        )}
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send"><Icon name="send" size={17} /></button>
      </form>
    </div>
  );
}
