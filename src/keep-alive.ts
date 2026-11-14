import type { Logger } from './lib/logger.js';

const REQUEST_TIMEOUT_MS = 10_000;

export interface KeepAliveOptions {
  /** The service's own public address. */
  url: string;
  intervalMs: number;
  /** Replaceable so tests don't touch the network. */
  fetch?: typeof fetch;
}

/**
 * Render's free plan puts a service to sleep after 15 minutes without a request from outside, which drops every
 * WhatsApp connection and leaves messages unanswered until something wakes it again. Asking for our own public
 * address from time to time counts as a request from outside, so the service keeps itself awake. It cannot wake a
 * service that is already asleep, which is why FlexDesk pings it too.
 */
export class KeepAlive {
  private timer: NodeJS.Timeout | null = null;
  private readonly target: string;
  private readonly request: typeof fetch;
  private failing = false;

  constructor(
    private readonly options: KeepAliveOptions,
    private readonly logger: Logger,
  ) {
    this.target = new URL('/healthz', options.url).toString();
    this.request = options.fetch ?? fetch;
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.ping(), this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Never throws. A failure is logged once when it starts and once when it ends, not on every try. */
  async ping(): Promise<boolean> {
    try {
      const response = await this.request(this.target, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (this.failing) this.logger.info('Keep-alive ping is working again');
      this.failing = false;
      return true;
    } catch (error) {
      if (!this.failing) this.logger.warn({ error: error instanceof Error ? error.message : 'unknown' }, 'Keep-alive ping failed');
      this.failing = true;
      return false;
    }
  }
}
