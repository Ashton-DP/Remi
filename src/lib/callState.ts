/** In-memory store for active voice call sessions (keyed by Twilio CallSid). */

export interface CallSession {
  clinicId: string;
  clientId: string;
  conversationId: string;
  language: 'en-ZA' | 'af-ZA';
  isFirstTurn: boolean;
}

const sessions = new Map<string, CallSession>();

export const callState = {
  init(callSid: string, data: CallSession) {
    sessions.set(callSid, data);
  },
  get(callSid: string): CallSession | undefined {
    return sessions.get(callSid);
  },
  update(callSid: string, patch: Partial<CallSession>) {
    const s = sessions.get(callSid);
    if (s) sessions.set(callSid, { ...s, ...patch });
  },
  end(callSid: string) {
    sessions.delete(callSid);
  },
};
