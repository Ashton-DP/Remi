import type { Application, Request, Response, NextFunction } from 'express';
import { config } from '../config';

// Lightweight, optional error monitoring so failures aren't silent.
//
// Three layers, each independent and all no-ops until configured:
//  1. Sentry — used only if SENTRY_DSN is set AND @sentry/node is installed
//     (loaded via dynamic import, so it is NOT a hard dependency).
//  2. Webhook alerts — if MONITORING_WEBHOOK_URL is set (e.g. a Slack incoming
//     webhook), errors are POSTed there. Zero dependencies.
//  3. Console — always logs clearly.

let sentry: any = null;

export async function initMonitoring(): Promise<void> {
  // Surface crashes that would otherwise vanish.
  process.on('unhandledRejection', (reason) => {
    captureError(reason instanceof Error ? reason : new Error(String(reason)), { kind: 'unhandledRejection' });
  });
  process.on('uncaughtException', (err) => {
    captureError(err, { kind: 'uncaughtException' });
  });

  if (config.monitoring.sentryDsn) {
    try {
      const Sentry = await import('@sentry/node' as any);
      Sentry.init({ dsn: config.monitoring.sentryDsn, tracesSampleRate: 0 });
      sentry = Sentry;
      console.log('[monitoring] Sentry enabled');
    } catch {
      console.warn('[monitoring] SENTRY_DSN set but @sentry/node not installed — run `npm i @sentry/node`. Falling back to console/webhook.');
    }
  }
}

/** Report an error to every configured sink. Never throws. */
export function captureError(err: unknown, context: Record<string, unknown> = {}): void {
  const e = err instanceof Error ? err : new Error(String(err));
  console.error('[error]', context.kind ?? '', e.message, context);

  if (sentry) {
    try { sentry.captureException(e, { extra: context }); } catch { /* ignore */ }
  }

  const url = config.monitoring.webhookUrl;
  if (url) {
    const text = `🚨 Remi error: ${e.message}\ncontext: ${JSON.stringify(context)}`;
    // Fire-and-forget; don't let alerting failures cascade.
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
  }
}

/** Express error-handling middleware. Mount LAST, after all routes. */
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  captureError(err, { path: req.path, method: req.method });
  if (!res.headersSent) res.status(500).json({ error: 'internal_error' });
}

/** Convenience to attach the error handler to an app. */
export function attachErrorHandler(app: Application): void {
  app.use(errorHandler);
}
