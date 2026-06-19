import dotenv from 'dotenv';
dotenv.config();

function opt(name: string, fallback = ''): string {
  return process.env[name] ?? fallback;
}
function req(name: string): string {
  const v = process.env[name];
  if (!v) console.warn(`[config] missing env var: ${name}`);
  return v ?? '';
}

export const config = {
  port: parseInt(opt('PORT', '3000'), 10),
  aiProvider: (opt('AI_PROVIDER', 'gemini') as 'gemini' | 'claude'),
  gemini: {
    apiKey: opt('GEMINI_API_KEY'),
    model: opt('GEMINI_MODEL', 'gemini-2.5-flash'),
  },
  anthropicApiKey: opt('ANTHROPIC_API_KEY'),
  model: opt('ANTHROPIC_MODEL', 'claude-opus-4-8'),
  supabaseUrl: req('SUPABASE_URL'),
  supabaseServiceKey: req('SUPABASE_SERVICE_KEY'),
  twilio: {
    accountSid: req('TWILIO_ACCOUNT_SID'),
    authToken: req('TWILIO_AUTH_TOKEN'),
    whatsappFrom: opt('TWILIO_WHATSAPP_FROM', 'whatsapp:+14155238886'),
  },
  google: {
    calendarId: opt('GOOGLE_CALENDAR_ID', 'primary'),
    serviceAccountJson: opt('GOOGLE_SERVICE_ACCOUNT_JSON'),
  },
  // Voice mode: 'gather' (TwiML <Gather>/<Say> — works today) or 'conversationrelay'
  // (real-time WebSocket + ElevenLabs natural voice — needs Twilio CR onboarding).
  voice: {
    mode: opt('VOICE_MODE', 'gather'),
    elevenLabsVoiceId: opt('ELEVENLABS_VOICE_ID'),
    // Public wss:// URL of this server's ConversationRelay WebSocket endpoint.
    wsUrl: opt('PUBLIC_WS_URL', 'wss://www.remireception.com/ws/voice'),
    ttsProvider: opt('CR_TTS_PROVIDER', 'ElevenLabs'),
    transcriptionProvider: opt('CR_STT_PROVIDER', 'Deepgram'),
    // Optional ElevenLabs model suffix appended to the voice id (e.g. 'turbo_v2_5'
    // for more natural output than the default 'flash_v2_5'). Blank = Twilio default.
    elevenLabsModel: opt('CR_ELEVENLABS_MODEL', ''),
    // --- Custom Media Streams pipeline (VOICE_MODE=mediastream) ---
    // Brings our OWN ElevenLabs (premium voices) + Deepgram (streaming STT).
    elevenLabsApiKey: opt('ELEVENLABS_API_KEY'),
    elevenLabsTtsModel: opt('ELEVENLABS_TTS_MODEL', 'eleven_turbo_v2_5'),
    deepgramApiKey: opt('DEEPGRAM_API_KEY'),
    deepgramModel: opt('DEEPGRAM_MODEL', 'nova-2-phonecall'),
    mediaWsUrl: opt('PUBLIC_MEDIA_WS_URL', 'wss://www.remireception.com/ws/media'),
  },
  // WhatsApp Business API approved-template Content SIDs (HX…). Set after Meta
  // approval; when blank, proactive sends fall back to free-form text (sandbox).
  // See docs/whatsapp-templates.md.
  templates: {
    reminder48h: opt('WA_TEMPLATE_REMINDER_48H'),
    reminder24h: opt('WA_TEMPLATE_REMINDER_24H'),
    reminder2h: opt('WA_TEMPLATE_REMINDER_2H'),
    waitlistOffer: opt('WA_TEMPLATE_WAITLIST_OFFER'),
    missedCall: opt('WA_TEMPLATE_MISSED_CALL'),
  },
  defaultClinicId: opt('DEFAULT_CLINIC_ID'),
  // Shared secret for the /tools/* webhooks the ElevenLabs agent calls. If set,
  // requests must include header X-Tool-Secret. Blank = open (dev/testing only).
  toolsSecret: opt('TOOLS_SHARED_SECRET'),
};
