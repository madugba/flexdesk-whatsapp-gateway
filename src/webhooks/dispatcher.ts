import type { Logger } from '../lib/logger.js';
import type { OutboxEvent, WebhookOutbox } from './outbox.js';
import { SIGNATURE_HEADER, signBody } from './signature.js';

const MAX_ATTEMPTS = 15;
const BATCH_SIZE = 20;
const CONCURRENCY = 5;
const IDLE_POLL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;

/** 5s, 10s, 20s ... capped at one hour, with jitter. */
export function retryDelaySeconds(attemptsSoFar: number, random: () => number = Math.random): number {
  const base = Math.min(5 * 2 ** Math.max(0, attemptsSoFar), 3_600);
  return Math.round(base * (0.8 + random() * 0.4));
}

export interface DispatcherOptions {
  url: string;
  secret: string;
  fetchImpl?: typeof fetch;
}

/**
 * Delivers queued events to FlexDesk, signed so FlexDesk can tell they are ours. Anything
 * but a 2xx is retried with backoff for about eight hours before the event is parked as
 * failed. FlexDesk deduplicates by event id, so at-least-once delivery is safe.
 */
export class WebhookDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private wakeRequested = false;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly outbox: WebhookOutbox,
    private readonly options: DispatcherOptions,
    private readonly logger: Logger,
  ) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    while (this.running) await new Promise((resolve) => setTimeout(resolve, 25));
  }

  /** Delivers new events immediately instead of waiting for the next poll. */
  nudge(): void {
    if (this.stopped) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    this.schedule(0);
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    let processed = 0;
    try {
      const events = await this.outbox.claimDue(BATCH_SIZE);
      processed = events.length;
      for (let i = 0; i < events.length; i += CONCURRENCY) {
        await Promise.all(events.slice(i, i + CONCURRENCY).map((event) => this.deliver(event)));
      }
    } catch (error) {
      this.logger.error({ error }, 'Webhook delivery loop failed');
    } finally {
      this.running = false;
      const again = processed === BATCH_SIZE || this.wakeRequested;
      this.wakeRequested = false;
      this.schedule(again ? 0 : IDLE_POLL_MS);
    }
  }

  private async deliver(event: OutboxEvent): Promise<void> {
    const body = JSON.stringify({
      id: event.id,
      type: event.eventType,
      sessionId: event.sessionId,
      occurredAt: event.createdAt.toISOString(),
      data: event.payload,
    });

    try {
      const response = await this.fetchImpl(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'flexdesk-whatsapp-gateway',
          [SIGNATURE_HEADER]: signBody(this.options.secret, body),
          'x-gateway-event-id': event.id,
          'x-gateway-event-type': event.eventType,
        },
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        await this.outbox.markDelivered(event.id);
        return;
      }
      await this.fail(event, `Receiver answered ${response.status}`);
    } catch (error) {
      await this.fail(event, error instanceof Error ? error.message : 'Delivery failed');
    }
  }

  private async fail(event: OutboxEvent, reason: string): Promise<void> {
    const attempt = event.attempts + 1;
    if (attempt >= MAX_ATTEMPTS) {
      this.logger.error({ eventId: event.id, type: event.eventType, reason }, 'Giving up on webhook event');
      await this.outbox.markFailed(event.id, reason);
      return;
    }
    this.logger.warn({ eventId: event.id, type: event.eventType, attempt, reason }, 'Webhook delivery failed, will retry');
    await this.outbox.markRetry(event.id, reason, retryDelaySeconds(event.attempts));
  }
}
