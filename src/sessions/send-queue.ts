import { errors } from '../lib/errors.js';

export interface SendQueueOptions {
  maxQueued: number;
  maxPerHour: number;
  minIntervalMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => number;
}

/**
 * Sends for one session go out one at a time, spaced a little apart with some jitter, and
 * capped per hour. Bursts of identical, instant messages are what WhatsApp's spam systems
 * look for, so the queue deliberately behaves more like a person than a script.
 */
export class SendQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private waiting = 0;
  private lastFinishedAt = 0;
  private readonly sentAt: number[] = [];

  constructor(private readonly options: SendQueueOptions) {}

  get length(): number {
    return this.waiting;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.waiting >= this.options.maxQueued) throw errors.queueFull();

    const hourAgo = this.options.now() - 3_600_000;
    while (this.sentAt.length > 0 && (this.sentAt[0] as number) < hourAgo) this.sentAt.shift();
    if (this.sentAt.length + this.waiting >= this.options.maxPerHour) throw errors.rateLimited();

    this.waiting += 1;
    const result = this.tail.then(async () => {
      try {
        const wait = this.lastFinishedAt + this.spacing() - this.options.now();
        if (wait > 0) await this.options.sleep(wait);
        return await task();
      } finally {
        this.waiting -= 1;
        this.lastFinishedAt = this.options.now();
        this.sentAt.push(this.lastFinishedAt);
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private spacing(): number {
    return this.options.minIntervalMs * (1 + this.options.random() * 0.6);
  }
}
