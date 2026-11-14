import type pg from 'pg';
import type { Database } from './database.js';
import type { Logger } from '../lib/logger.js';

const LOCK_KEY = 7_265_002;
const RETRY_MS = 3_000;

export interface LeaderCallbacks {
  onAcquired(): Promise<void> | void;
  onLost(): Promise<void> | void;
}

/**
 * Only one gateway process may hold WhatsApp connections: two processes using the same
 * credentials fight over the session and risk the number being flagged. Render starts the
 * new instance before stopping the old one during a deploy, so the new one waits here
 * until the old one releases the lock.
 *
 * The lock is a Postgres session-level advisory lock on a dedicated connection. If that
 * connection drops, the lock is gone, so leadership is reported lost and sessions stop.
 */
export class LeaderLock {
  private client: pg.Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private leader = false;

  constructor(
    private readonly db: Database,
    private readonly callbacks: LeaderCallbacks,
    private readonly logger: Logger,
  ) {}

  get isLeader(): boolean {
    return this.leader;
  }

  start(): void {
    this.stopped = false;
    void this.attempt();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.release();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.attempt(), RETRY_MS);
  }

  private async attempt(): Promise<void> {
    if (this.stopped || this.leader) return;
    let client: pg.Client | null = null;
    try {
      client = await this.db.dedicatedClient();
      const { rows } = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
      if (!rows[0]?.locked) {
        await client.end().catch(() => undefined);
        this.schedule();
        return;
      }
    } catch (error) {
      this.logger.warn({ error }, 'Could not reach the database to take the leader lock');
      await client?.end().catch(() => undefined);
      this.schedule();
      return;
    }

    if (this.stopped) {
      await client.end().catch(() => undefined);
      return;
    }

    this.client = client;
    this.leader = true;
    client.on('error', () => void this.lose('connection error'));
    client.on('end', () => void this.lose('connection closed'));
    this.logger.info('Took the leader lock');
    try {
      await this.callbacks.onAcquired();
    } catch (error) {
      this.logger.error({ error }, 'Starting as leader failed');
      await this.lose('start failed');
    }
  }

  private async lose(reason: string): Promise<void> {
    if (!this.leader) return;
    this.leader = false;
    this.client = null;
    this.logger.warn({ reason }, 'Lost the leader lock');
    try {
      await this.callbacks.onLost();
    } finally {
      this.schedule();
    }
  }

  private async release(): Promise<void> {
    const client = this.client;
    const wasLeader = this.leader;
    this.client = null;
    this.leader = false;
    if (!client) return;
    client.removeAllListeners('end');
    client.removeAllListeners('error');
    if (wasLeader) {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}
