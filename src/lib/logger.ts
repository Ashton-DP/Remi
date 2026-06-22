import type { Request, Response, NextFunction } from 'express';

// Minimal structured (JSON-line) logger. One object per line → easy to grep,
// ship, and query in Railway/any log aggregator. Keep PII out of fields.

type Fields = Record<string, unknown>;
type Level = 'info' | 'warn' | 'error';

function emit(level: Level, msg: string, fields: Fields = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
};

/** Express middleware: one structured line per request (method, path, status,
 *  duration). Skips health checks to avoid uptime-ping noise. No request body /
 *  PII is logged. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/health' || req.path === '/health/db') return next();
  const start = Date.now();
  res.on('finish', () => {
    log.info('http', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
  });
  next();
}
