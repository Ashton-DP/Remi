/** In-memory store for active voice call sessions (keyed by Twilio CallSid). */

export interface CallSession {
  clinicId: string;
  clientId: string;
  conversationId: string;
  language: 'en-GB' | 'af-ZA';
  isFirstTurn: boolean;
}

interface Stored { data: CallSession; ts: number }
const sessions = new Map<string, Stored>();

// TTL sweep: entries are normally removed by end() on the call-status webhook, but
// if that webhook is missed the entry would leak forever. A call never lasts an
// hour, so evict anything older than that.
const TTL_MS = 60 * 60_000;
const sweep = setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of sessions) if (v.ts < cutoff) sessions.delete(k);
}, 10 * 60_000);
sweep.unref?.();

export const callState = {
  init(callSid: string, data: CallSession) {
    sessions.set(callSid, { data, ts: Date.now() });
  },
  get(callSid: string): CallSession | undefined {
    return sessions.get(callSid)?.data;
  },
  update(callSid: string, patch: Partial<CallSession>) {
    const s = sessions.get(callSid);
    if (s) sessions.set(callSid, { data: { ...s.data, ...patch }, ts: Date.now() });
  },
  end(callSid: string) {
    sessions.delete(callSid);
  },
};
