import twilio from 'twilio';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config';

/**
 * Express middleware that verifies an inbound request genuinely came from Twilio
 * by checking the X-Twilio-Signature header against the request URL + params.
 *
 * Without this, anyone who discovers a /webhooks/* URL can POST fake messages,
 * trigger bookings, and run up AI spend. See:
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 *
 * Skipped (with a warning) when no Twilio auth token is configured (local dev),
 * or when TWILIO_SKIP_VALIDATION=true (explicit opt-out for manual testing).
 * Requires app.set('trust proxy', true) so the forwarded https host is trusted
 * behind Render's TLS-terminating proxy.
 */
export function validateTwilioWebhook(req: Request, res: Response, next: NextFunction) {
  if (!config.twilio.authToken) {
    // Fail CLOSED in production: an unsigned-but-accepted webhook lets anyone
    // forge inbound messages/calls (AI spend, fake bookings, outbound WhatsApp).
    if (process.env.NODE_ENV === 'production') {
      console.error('[twilio] BLOCKED: signature validation impossible — no auth token in production');
      return res.status(503).type('text/plain').send('Webhook validation not configured');
    }
    console.warn('[twilio] signature validation skipped — no auth token (non-production)');
    return next();
  }
  if (process.env.TWILIO_SKIP_VALIDATION === 'true') return next();

  const signature = req.header('X-Twilio-Signature') ?? '';
  // Twilio signs the exact public URL it called. Behind Render's proxy, prefer
  // the forwarded host and force https (Twilio webhooks are always https).
  const host = req.header('X-Forwarded-Host') ?? req.get('host');
  const url = `https://${host}${req.originalUrl}`;
  const params = (req.body ?? {}) as Record<string, unknown>;

  const valid = twilio.validateRequest(config.twilio.authToken, signature, url, params);
  if (!valid) {
    console.warn(`[twilio] REJECTED request with invalid signature: ${url}`);
    return res.status(403).type('text/plain').send('Invalid Twilio signature');
  }
  next();
}
