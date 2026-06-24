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

export function Assistant() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Opening brief — sent silently so the manager just sees Remi's rundown.
  useEffect(() => {
    const opener: Msg = { role: 'user', content: 'Give me my brief for today.', hidden: true };
    setMsgs([opener]); setBusy(true);
    api<{ reply: string }>('/api/assistant', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: opener.content }] }) })
      .then(({ reply }) => setMsgs([opener, { role: 'assistant', content: reply }]))
      .catch(() => setMsgs([opener, { role: 'assistant', content: 'Sorry — I had trouble loading your brief. Try asking me something below.' }]))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    const next = [...msgs, { role: 'user', content: text } as Msg];
    setMsgs(next); setInput(''); setBusy(true);
    try {
      const { reply } = await api<{ reply: string }>('/api/assistant', {
        method: 'POST', body: JSON.stringify({ messages: next.map(({ role, content }) => ({ role, content })) }),
      });
      setMsgs([...next, { role: 'assistant', content: reply }]);
    } catch (e: any) {
      setMsgs([...next, { role: 'assistant', content: 'Sorry — I had trouble. ' + e.message }]);
    } finally { setBusy(false); }
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
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask Remi anything, or tell it what to do…" disabled={busy} />
        <button type="submit" disabled={busy || !input.trim()} aria-label="Send"><Icon name="send" size={17} /></button>
      </form>
    </div>
  );
}
