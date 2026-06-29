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
  // Public anon key — used by the dashboard SPA for Supabase Auth (login). Safe
  // to expose to the browser; RLS + API scoping enforce access.
  supabaseAnonKey: opt('SUPABASE_ANON_KEY'),
  twilio: {
    accountSid: req('TWILIO_ACCOUNT_SID'),
    authToken: req('TWILIO_AUTH_TOKEN'),
    whatsappFrom: opt('TWILIO_WHATSAPP_FROM', 'whatsapp:+14155238886'),
    // SMS fallback (no Meta needed). Set TWILIO_SMS_FROM to your SA number and
    // MESSAGING_CHANNEL=sms to route proactive messages over SMS instead of
    // WhatsApp (useful while the WhatsApp/Meta restriction is unresolved).
    smsFrom: opt('TWILIO_SMS_FROM'),
    channel: (opt('MESSAGING_CHANNEL', 'whatsapp') as 'whatsapp' | 'sms'),
  },
  google: {
    calendarId: opt('GOOGLE_CALENDAR_ID', 'primary'),
    serviceAccountJson: opt('GOOGLE_SERVICE_ACCOUNT_JSON'),
  },
  // Voice mode: 'gather' (TwiML <Gather>/<Say> — works today) or 'conversationrelay'
  // (real-time WebSocket + ElevenLabs natural voice — needs Twilio CR onboarding).
  voice: {
    mode: opt('VOICE_MODE', 'mediastream'),
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
    // --- Azure Speech (English/Afrikaans/isiZulu STT auto-detect + Azure TTS) ---
    // Azure handles STT (understanding the caller) AND TTS (Remi's voice): a natural
    // multilingual voice per language. ElevenLabs is only a fallback if no Azure key.
    azureSpeechKey: opt('AZURE_SPEECH_KEY'),
    // Optional DEDICATED STT key. Azure keys are region-bound, and full multi-language
    // continuous language-ID (en/af/zu auto-detect) needs westeurope/eastus —
    // southafricanorth does NOT support it. So: to get af/zu auto-detect, create a
    // Speech resource in westeurope and set AZURE_STT_KEY + AZURE_STT_REGION. If you
    // leave AZURE_STT_KEY blank, STT falls back to the main key/region (works with a
    // single SA key, but English-primary recognition).
    azureSttKey: opt('AZURE_STT_KEY'),
    azureSttRegion: opt('AZURE_STT_REGION', 'westeurope'),
    // TTS region: southafricanorth is fine for af-ZA TTS (just voice synthesis, no LID).
    azureSpeechRegion: opt('AZURE_SPEECH_REGION', 'southafricanorth'),
    // Candidate languages for auto-detection (English + Afrikaans + isiZulu — the
    // three most-spoken; handles code-switching). Azure caps continuous LID at 4.
    // STT auto-detect candidate languages (English, Afrikaans, isiZulu). Per-utterance
    // 3-way language-ID is unreliable on short audio, so the media pipeline detects the
    // language ONCE per call and locks it (with two-signal corroboration + hysteresis)
    // rather than re-deciding every sentence — see src/routes/mediaStream.ts.
    azureSttLanguages: opt('AZURE_STT_LANGUAGES', 'en-ZA,af-ZA,zu-ZA').split(',').map((s) => s.trim()).filter(Boolean),
    // Azure TTS voice per reply language. en/af use natural multilingual voices
    // (spoken via SSML in the right locale); zu uses the native isiZulu voice.
    azureVoiceEn: opt('AZURE_VOICE_EN', 'en-US-AvaMultilingualNeural'),
    azureVoiceAf: opt('AZURE_VOICE_AF', 'en-GB-AdaMultilingualNeural'),
    azureVoiceZu: opt('AZURE_VOICE_ZU', 'zu-ZA-ThandoNeural'),
    // How long Azure waits for silence before finalising a caller's utterance.
    azureSttSilenceMs: parseInt(opt('AZURE_STT_SILENCE_MS', '400'), 10),
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
    aftercare: opt('WA_TEMPLATE_AFTERCARE'),
    review: opt('WA_TEMPLATE_REVIEW'),
    reactivation: opt('WA_TEMPLATE_REACTIVATION'),
    deposit: opt('WA_TEMPLATE_DEPOSIT'),
  },
  defaultClinicId: opt('DEFAULT_CLINIC_ID'),
  operatorAlertPhone: opt('OPERATOR_ALERT_PHONE'), // Ashton's WhatsApp for new-clinic alerts
  // Dashboard / report access. FAIL-CLOSED: if no token is set, /dashboard and
  // /report are disabled (they expose patient data). Set a long random value.
  // A clinic can also have its own clinics.dashboard_token for a scoped link.
  dashboard: {
    token: opt('DASHBOARD_TOKEN'),
  },
  // Digital patient intake form. Sent to first-time patients on booking when
  // enabled. Links are signed with INTAKE_SECRET (falls back to TOOLS_SHARED_SECRET).
  intake: {
    enabled: opt('INTAKE_ENABLED') === 'true',
    secret: opt('INTAKE_SECRET') || opt('TOOLS_SHARED_SECRET') || 'remi-intake-dev',
  },
  // Self-serve onboarding form. Submissions require this token (fail-closed when
  // unset) so the public /onboard page can't be used to spam-create clinics.
  onboard: {
    token: opt('ONBOARD_TOKEN'),
  },
  // Error monitoring. All optional: SENTRY_DSN (needs @sentry/node installed),
  // MONITORING_WEBHOOK_URL (e.g. a Slack incoming webhook). Unset = console only.
  monitoring: {
    sentryDsn: opt('SENTRY_DSN'),
    webhookUrl: opt('MONITORING_WEBHOOK_URL'),
  },
  // Shared secret for the /tools/* webhooks the ElevenLabs agent calls. If set,
  // requests must include header X-Tool-Secret. Blank = open (dev/testing only).
  toolsSecret: opt('TOOLS_SHARED_SECRET'),
  // Invoice chasing (PaidUp engine). OFF by default — outbound auto-chasing must
  // be a deliberate choice. CHASE_ENABLED=true turns on the daily scheduler run;
  // CHASE_HOUR is the clinic-local hour (Mon–Fri) it runs. The /invoices/import
  // route is gated by CHASE_IMPORT_TOKEN (falls back to ONBOARD_TOKEN).
  chase: {
    enabled: opt('CHASE_ENABLED') === 'true',
    hour: parseInt(opt('CHASE_HOUR', '9'), 10),
    importToken: opt('CHASE_IMPORT_TOKEN') || opt('ONBOARD_TOKEN'),
  },
  // Payment links in chase messages. Each clinic brings its own provider +
  // credentials (PayFast merchant / Paystack secret / a static pay link),
  // stored on the clinic. PUBLIC_BASE_URL is where /pay/:id is served.
  payments: {
    publicBase: opt('PUBLIC_BASE_URL', 'https://www.remireception.com'),
    payfastSandbox: opt('PAYFAST_SANDBOX') === 'true',
    paypalSandbox: opt('PAYPAL_SANDBOX') === 'true',
  },
  // Email channel for invoice chasing (invoice contacts usually have email, not
  // phone). Sends via Resend when RESEND_API_KEY is set; otherwise logs only.
  // EMAIL_FROM must be on a domain verified in Resend (e.g. billing@remireception.com).
  email: {
    resendApiKey: opt('RESEND_API_KEY'),
    fromEmail: opt('EMAIL_FROM', 'billing@remireception.com'),
    get enabled() { return !!this.resendApiKey; },
  },
  // Invoice sources — auto-import overdue invoices from accounting tools.
  // OAuth providers need a developer app (client id/secret + redirect URI) per
  // provider; Google Sheet needs nothing but a published-CSV URL on the clinic.
  // Redirect URIs default to <PUBLIC_BASE_URL>/connect/<provider>/callback.
  invoiceSources: {
    xero: {
      clientId: opt('XERO_CLIENT_ID'),
      clientSecret: opt('XERO_CLIENT_SECRET'),
      redirectUri: opt('XERO_REDIRECT_URI', (opt('PUBLIC_BASE_URL', 'https://www.remireception.com')) + '/connect/xero/callback'),
    },
    quickbooks: {
      clientId: opt('QBO_CLIENT_ID'),
      clientSecret: opt('QBO_CLIENT_SECRET'),
      redirectUri: opt('QBO_REDIRECT_URI', (opt('PUBLIC_BASE_URL', 'https://www.remireception.com')) + '/connect/quickbooks/callback'),
    },
    sage: {
      clientId: opt('SAGE_CLIENT_ID'),
      clientSecret: opt('SAGE_CLIENT_SECRET'),
      redirectUri: opt('SAGE_REDIRECT_URI', (opt('PUBLIC_BASE_URL', 'https://www.remireception.com')) + '/connect/sage/callback'),
    },
  },
  // Stripe deposits. Off unless secretKey + a clinic deposit_zar are set.
  stripe: {
    secretKey: opt('STRIPE_SECRET_KEY'),
    webhookSecret: opt('STRIPE_WEBHOOK_SECRET'),
    // Where Stripe sends a new subscriber after checkout — lands on the dashboard login with a welcome banner.
    successUrl: opt('STRIPE_SUCCESS_URL', 'https://www.remireception.com/app?welcome=1'),
  },
};

/**
 * Fail fast at boot if a critical var is missing IN PRODUCTION. Without this,
 * `req()` only warns and the process boots broken, failing later at first use.
 * Dev/test are exempt so they can run with partial config. Call once at startup.
 */
export function assertProductionConfig(): void {
  if (process.env.NODE_ENV !== 'production') return;
  const missing: string[] = [];
  const need: [string, string][] = [
    ['SUPABASE_URL', config.supabaseUrl],
    ['SUPABASE_SERVICE_KEY', config.supabaseServiceKey],
    ['TWILIO_ACCOUNT_SID', config.twilio.accountSid],
    ['TWILIO_AUTH_TOKEN', config.twilio.authToken],
  ];
  for (const [name, val] of need) if (!val) missing.push(name);
  // Need at least one LLM key for the brain to function.
  if (!config.gemini.apiKey && !config.anthropicApiKey) missing.push('GEMINI_API_KEY or ANTHROPIC_API_KEY');
  if (missing.length) {
    throw new Error(`[config] FATAL — missing required production env var(s): ${missing.join(', ')}`);
  }
}
