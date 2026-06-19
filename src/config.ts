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
};
