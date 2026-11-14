import type { Logger } from './lib/logger.js';
import type { SessionRepository } from './sessions/session-repository.js';

const INTERVAL_MS = 10 * 60_000;

/** Periodic housekeeping while this process is the leader: prune old rows and log memory use. */
export class Maintenance {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: SessionRepository,
    private readonly sessionCount: () => number,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.run(), INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async run(): Promise<void> {
    try {
      await this.repository.prune();
      const memory = process.memoryUsage();
      this.logger.info(
        { sessions: this.sessionCount(), rssMb: Math.round(memory.rss / 1_048_576), heapUsedMb: Math.round(memory.heapUsed / 1_048_576) },
        'Maintenance complete',
      );
    } catch (error) {
      this.logger.error({ error }, 'Maintenance failed');
    }
  }
}
