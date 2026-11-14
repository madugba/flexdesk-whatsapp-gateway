import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ['req.headers.authorization', '*.authorization', '*.apiKey', '*.secret', '*.qr', '*.creds', '*.text'],
      censor: '[redacted]',
    },
    base: { service: 'flexdesk-whatsapp-gateway' },
  });
}

/** Keeps only the last four digits so logs identify a number without exposing it. */
export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return 'unknown';
  return `***${phone.slice(-4)}`;
}
