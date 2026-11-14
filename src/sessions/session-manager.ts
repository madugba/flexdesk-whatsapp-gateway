import { randomUUID } from 'node:crypto';
import { reconnectDelayMs } from '../engine/disconnect.js';
import { parseRecipient, phoneToJid } from '../engine/jid.js';
import type { Engine, EngineEvent, EngineFactory, InboundMessage, OutboundDocument, SessionStatus } from '../engine/types.js';
import { errors, GatewayError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { maskPhone } from '../lib/logger.js';
import type { WebhookDispatcher } from '../webhooks/dispatcher.js';
import type { WebhookOutbox } from '../webhooks/outbox.js';
import { SendQueue } from './send-queue.js';
import type { SessionRepository, SessionRow } from './session-repository.js';

const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** A connection that stays open this long is considered healthy and resets the backoff. */
const STABLE_AFTER_MS = 60_000;
/** Pause between resuming sessions at startup, so they do not all log in at the same instant. */
const RESUME_STAGGER_MS = 750;
/** Statuses that are reported to FlexDesk. The QR code and connecting states are polled instead. */
const NOTIFIED: ReadonlySet<SessionStatus> = new Set(['open', 'reconnecting', 'logged_out', 'replaced', 'qr_expired', 'error']);

export interface SessionView {
  sessionId: string;
  status: SessionStatus;
  phone: string | null;
  /** The QR code to scan. Anyone holding it can link the account, so never log or cache it. */
  qr: string | null;
  connectedAt: string | null;
  lastDisconnect: { code: number | null; reason: string | null } | null;
}

export interface SessionManagerOptions {
  maxSessions: number;
  replyWindowHours: number;
  markRead: boolean;
  send: { minIntervalMs: number; maxPerHour: number; maxQueued: number };
}

export interface SessionManagerDeps {
  repository: SessionRepository;
  engines: EngineFactory;
  outbox: WebhookOutbox;
  dispatcher: Pick<WebhookDispatcher, 'nudge'>;
  options: SessionManagerOptions;
  logger: Logger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  reconnectDelay?: (attempt: number) => number;
}

interface Runtime {
  id: string;
  generation: number;
  engine: Engine | null;
  status: SessionStatus;
  phone: string | null;
  qr: string | null;
  connectedAt: Date | null;
  lastDisconnect: { code: number | null; reason: string | null } | null;
  reconnectAttempts: number;
  quickRestarts: number;
  reconnectTimer: NodeJS.Timeout | null;
  stableTimer: NodeJS.Timeout | null;
  queue: SendQueue;
  /** Events from the connection are handled one at a time, in the order they arrived. */
  events: Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Owns every live WhatsApp connection: starting them, keeping them up, recording what
 * arrives and sending what FlexDesk asks for. It runs only while this process is the
 * leader, so a connection never exists in two processes at once.
 */
export class SessionManager {
  private readonly runtimes = new Map<string, Runtime>();
  private active = false;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly reconnectDelay: (attempt: number) => number;

  constructor(private readonly deps: SessionManagerDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.reconnectDelay = deps.reconnectDelay ?? ((attempt) => reconnectDelayMs(attempt, this.random));
  }

  get isActive(): boolean {
    return this.active;
  }

  get sessionCount(): number {
    return this.runtimes.size;
  }

  /** Becomes active and resumes every session that was linked before the last shutdown. */
  async activate(): Promise<void> {
    this.active = true;
    const rows = await this.deps.repository.list();
    const resumable = rows.filter((row) => row.phone !== null && (['open', 'reconnecting', 'connecting'] as string[]).includes(row.status));

    for (const row of rows) {
      if (row.phone === null && (row.status === 'connecting' || row.status === 'qr')) {
        await this.deps.repository.updateStatus(row.id, { status: 'qr_expired' });
      }
    }

    for (const row of resumable) {
      if (!this.active) return;
      this.startRuntime(row.id, row);
      await this.sleep(RESUME_STAGGER_MS);
    }
  }

  /** Leadership lost or shutting down: close sockets without unlinking, so they resume later. */
  async deactivate(): Promise<void> {
    this.active = false;
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(
      runtimes.map(async (runtime) => {
        runtime.generation += 1;
        this.clearTimers(runtime);
        await runtime.engine?.stop().catch(() => undefined);
      }),
    );
  }

  async create(sessionId: string): Promise<SessionView> {
    this.requireActive();
    this.requireValidId(sessionId);

    const existing = this.runtimes.get(sessionId);
    if (existing) return this.view(existing);

    const row = await this.deps.repository.get(sessionId);
    if (!row && (await this.deps.repository.count()) >= this.deps.options.maxSessions) throw errors.capacity();
    if (!row) await this.deps.repository.insertIfMissing(sessionId);

    const runtime = this.startRuntime(sessionId, row);
    return this.view(runtime);
  }

  async get(sessionId: string): Promise<SessionView> {
    this.requireActive();
    const runtime = this.runtimes.get(sessionId);
    if (runtime) return this.view(runtime);

    const row = await this.deps.repository.get(sessionId);
    if (!row) throw errors.sessionNotFound();
    return this.viewOfRow(row);
  }

  async list(): Promise<SessionView[]> {
    this.requireActive();
    const rows = await this.deps.repository.list();
    return rows.map((row) => {
      const runtime = this.runtimes.get(row.id);
      return runtime ? { ...this.view(runtime), qr: null } : this.viewOfRow(row);
    });
  }

  /** Starts a fresh connection for a session that is not running (expired QR, replaced, errored, logged out). */
  async reconnect(sessionId: string): Promise<SessionView> {
    this.requireActive();
    const existing = this.runtimes.get(sessionId);
    if (existing && (existing.status === 'open' || existing.status === 'connecting' || existing.status === 'qr')) {
      return this.view(existing);
    }
    const row = await this.deps.repository.get(sessionId);
    if (!row) throw errors.sessionNotFound();

    if (existing) {
      existing.generation += 1;
      this.clearTimers(existing);
      await existing.engine?.stop().catch(() => undefined);
      this.runtimes.delete(sessionId);
    }
    return this.view(this.startRuntime(sessionId, row));
  }

  /** Unlinks the device at WhatsApp and deletes everything stored for the session. */
  async remove(sessionId: string): Promise<void> {
    this.requireActive();
    const runtime = this.runtimes.get(sessionId);
    if (!runtime && !(await this.deps.repository.get(sessionId))) throw errors.sessionNotFound();

    if (runtime) {
      runtime.generation += 1;
      this.clearTimers(runtime);
      this.runtimes.delete(sessionId);
      if (runtime.status === 'open') await runtime.engine?.logout().catch(() => undefined);
      else await runtime.engine?.stop().catch(() => undefined);
    }
    await this.deps.repository.delete(sessionId);
  }

  /** Sends a text message to someone who has messaged this number within the reply window. */
  send(sessionId: string, to: string, text: string, idempotencyKey: string | undefined): Promise<{ messageId: string; chatId: string }> {
    return this.sendGuarded(sessionId, to, idempotencyKey, (runtime, chatId) => this.deliverText(runtime, chatId, text));
  }

  /** Same guards as `send` -- reply window, idempotency, the paced queue -- for a file. */
  sendDocument(
    sessionId: string,
    to: string,
    document: OutboundDocument,
    idempotencyKey: string | undefined,
  ): Promise<{ messageId: string; chatId: string }> {
    return this.sendGuarded(sessionId, to, idempotencyKey, (runtime, chatId) => this.deliverDocument(runtime, chatId, document));
  }

  private async sendGuarded(
    sessionId: string,
    to: string,
    idempotencyKey: string | undefined,
    deliver: (runtime: Runtime, chatId: string) => Promise<{ messageId: string }>,
  ): Promise<{ messageId: string; chatId: string }> {
    this.requireActive();
    const runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      if (!(await this.deps.repository.get(sessionId))) throw errors.sessionNotFound();
      throw errors.sessionNotOpen('stopped');
    }
    if (runtime.status !== 'open') throw errors.sessionNotOpen(runtime.status);

    const recipient = parseRecipient(to);
    if (!recipient) throw errors.invalidRecipient();
    const windowJids = recipient.phone ? [recipient.jid, phoneToJid(recipient.phone)] : [recipient.jid];
    const since = new Date(this.now() - this.deps.options.replyWindowHours * 3_600_000);
    if (!(await this.deps.repository.hasOpenWindow(sessionId, windowJids, since))) throw errors.outsideReplyWindow();

    const key = idempotencyKey ?? randomUUID();
    const claim = await this.deps.repository.claimSend(sessionId, key);
    if (!claim.claimed) {
      if (claim.messageId) return { messageId: claim.messageId, chatId: recipient.jid };
      throw errors.duplicateInFlight();
    }

    try {
      const sent = await runtime.queue.run(() => deliver(runtime, recipient.jid));
      await this.deps.repository.completeSend(sessionId, key, sent.messageId);
      return { messageId: sent.messageId, chatId: recipient.jid };
    } catch (error) {
      await this.deps.repository.releaseSend(sessionId, key);
      if (error instanceof GatewayError) throw error;
      this.deps.logger.warn({ error, sessionId }, 'Sending a message failed');
      throw errors.sendFailed();
    }
  }

  /** Shows "typing..." for a moment first, the way a person would, then sends. */
  private async withTyping(runtime: Runtime, chatId: string, typingMs: number, send: (engine: Engine) => Promise<{ messageId: string }>) {
    const engine = runtime.engine;
    if (!engine || runtime.status !== 'open') throw errors.sessionNotOpen(runtime.status);

    await engine.sendPresence(chatId, 'composing').catch(() => undefined);
    await this.sleep(typingMs * (0.8 + this.random() * 0.4));
    try {
      return await send(engine);
    } finally {
      await engine.sendPresence(chatId, 'paused').catch(() => undefined);
    }
  }

  private deliverText(runtime: Runtime, chatId: string, text: string) {
    return this.withTyping(runtime, chatId, Math.min(3_000, 300 + text.length * 25), (engine) => engine.sendText(chatId, text));
  }

  private deliverDocument(runtime: Runtime, chatId: string, document: OutboundDocument) {
    return this.withTyping(runtime, chatId, 1_200, (engine) => engine.sendDocument(chatId, document));
  }

  private startRuntime(sessionId: string, row: SessionRow | null): Runtime {
    const runtime: Runtime = {
      id: sessionId,
      generation: 0,
      engine: null,
      status: 'connecting',
      phone: row?.phone ?? null,
      qr: null,
      connectedAt: row?.lastConnectedAt ?? null,
      lastDisconnect: null,
      reconnectAttempts: 0,
      quickRestarts: 0,
      reconnectTimer: null,
      stableTimer: null,
      events: Promise.resolve(),
      queue: new SendQueue({
        ...this.deps.options.send,
        maxQueued: this.deps.options.send.maxQueued,
        sleep: this.sleep,
        random: this.random,
        now: this.now,
      }),
    };
    this.runtimes.set(sessionId, runtime);
    void this.connect(runtime);
    return runtime;
  }

  private async connect(runtime: Runtime): Promise<void> {
    if (!this.runtimes.has(runtime.id) || this.runtimes.get(runtime.id) !== runtime) return;
    runtime.generation += 1;
    const generation = runtime.generation;
    runtime.reconnectTimer = null;
    if (runtime.status !== 'reconnecting') runtime.status = 'connecting';
    runtime.qr = null;

    try {
      const engine = await this.deps.engines.create(runtime.id);
      if (runtime.generation !== generation) {
        await engine.stop().catch(() => undefined);
        return;
      }
      runtime.engine = engine;
      engine.onEvent((event) => this.enqueueEvent(runtime, generation, event));
      await engine.start();
      if (runtime.status === 'connecting') await this.deps.repository.updateStatus(runtime.id, { status: 'connecting' });
    } catch (error) {
      if (runtime.generation !== generation) return;
      this.deps.logger.error({ error, sessionId: runtime.id }, 'Starting the WhatsApp connection failed');
      await this.scheduleReconnect(runtime, 0, 'Could not start the connection');
    }
  }

  private enqueueEvent(runtime: Runtime, generation: number, event: EngineEvent): void {
    runtime.events = runtime.events.then(() => this.handleEvent(runtime, generation, event));
  }

  private async handleEvent(runtime: Runtime, generation: number, event: EngineEvent): Promise<void> {
    if (runtime.generation !== generation || !this.active) return;
    try {
      switch (event.type) {
        case 'qr':
          runtime.qr = event.qr;
          if (runtime.status !== 'qr') await this.setStatus(runtime, 'qr');
          return;
        case 'open':
          await this.onOpen(runtime, event.phone);
          return;
        case 'close':
          await this.onClose(runtime, event);
          return;
        case 'message':
          await this.onMessage(runtime, event.message);
          return;
      }
    } catch (error) {
      this.deps.logger.error({ error, sessionId: runtime.id, eventType: event.type }, 'Handling a WhatsApp event failed');
    }
  }

  private async onOpen(runtime: Runtime, phone: string | null): Promise<void> {
    runtime.qr = null;
    runtime.phone = phone ?? runtime.phone;
    runtime.connectedAt = new Date(this.now());
    runtime.quickRestarts = 0;
    runtime.lastDisconnect = null;
    if (runtime.stableTimer) clearTimeout(runtime.stableTimer);
    runtime.stableTimer = setTimeout(() => {
      runtime.reconnectAttempts = 0;
    }, STABLE_AFTER_MS);

    this.deps.logger.info({ sessionId: runtime.id, phone: maskPhone(runtime.phone) }, 'WhatsApp session connected');
    await this.setStatus(runtime, 'open', { phone: runtime.phone, connectedAt: runtime.connectedAt });
  }

  private async onClose(runtime: Runtime, event: Extract<EngineEvent, { type: 'close' }>): Promise<void> {
    runtime.engine = null;
    runtime.qr = null;
    if (runtime.stableTimer) clearTimeout(runtime.stableTimer);
    runtime.lastDisconnect = { code: event.code ?? null, reason: event.reason };
    const disconnect = { disconnectCode: event.code ?? null, disconnectReason: event.reason };
    this.deps.logger.info({ sessionId: runtime.id, code: event.code, disposition: event.disposition }, 'WhatsApp connection closed');

    switch (event.disposition) {
      case 'reconnect_now':
        runtime.quickRestarts += 1;
        if (runtime.quickRestarts <= 3) {
          await this.connect(runtime);
          return;
        }
        await this.scheduleReconnect(runtime, 1, event.reason);
        return;
      case 'reconnect':
        await this.scheduleReconnect(runtime, runtime.reconnectAttempts + 1, event.reason);
        return;
      case 'logged_out':
        await this.deps.repository.purgeAuth(runtime.id);
        runtime.phone = null;
        await this.setStatus(runtime, 'logged_out', disconnect);
        return;
      case 'relink':
        await this.deps.repository.purgeAuth(runtime.id);
        runtime.phone = null;
        await this.setStatus(runtime, 'error', disconnect);
        return;
      case 'replaced':
        await this.setStatus(runtime, 'replaced', disconnect);
        return;
      case 'qr_expired':
        await this.setStatus(runtime, 'qr_expired', disconnect);
        return;
    }
  }

  private async scheduleReconnect(runtime: Runtime, attempt: number, reason: string): Promise<void> {
    runtime.reconnectAttempts = attempt;
    const delay = this.reconnectDelay(Math.max(1, attempt));
    this.deps.logger.warn({ sessionId: runtime.id, attempt, delayMs: delay, reason }, 'Reconnecting WhatsApp session');
    await this.setStatus(runtime, 'reconnecting', { disconnectReason: reason });
    runtime.reconnectTimer = setTimeout(() => void this.connect(runtime), delay);
  }

  private async onMessage(runtime: Runtime, message: InboundMessage): Promise<void> {
    const windowJids = [...new Set([message.chatId, ...(message.phone ? [phoneToJid(message.phone)] : [])])];
    const recorded = await this.deps.repository.recordInbound(runtime.id, message, windowJids, (client) =>
      this.deps.outbox.enqueue(
        runtime.id,
        'message.received',
        {
          messageId: message.messageId,
          chatId: message.chatId,
          phone: message.phone,
          pushName: message.pushName,
          timestamp: message.timestamp,
          type: message.type,
          text: message.text,
        },
        client,
      ),
    );
    if (!recorded) return;

    this.deps.dispatcher.nudge();
    if (this.deps.options.markRead && runtime.status === 'open') {
      runtime.engine?.markRead(message).catch(() => undefined);
    }
  }

  private async setStatus(
    runtime: Runtime,
    status: SessionStatus,
    extra: { phone?: string | null; connectedAt?: Date; disconnectCode?: number | null; disconnectReason?: string | null } = {},
  ): Promise<void> {
    const changed = runtime.status !== status;
    runtime.status = status;
    await this.deps.repository.updateStatus(runtime.id, { status, ...extra });

    if (changed && NOTIFIED.has(status)) {
      await this.deps.outbox.enqueue(runtime.id, 'session.status', {
        status,
        phone: runtime.phone,
        reason: runtime.lastDisconnect?.reason ?? null,
      });
      this.deps.dispatcher.nudge();
    }
  }

  private view(runtime: Runtime): SessionView {
    return {
      sessionId: runtime.id,
      status: runtime.status,
      phone: runtime.phone,
      qr: runtime.status === 'qr' ? runtime.qr : null,
      connectedAt: runtime.connectedAt?.toISOString() ?? null,
      lastDisconnect: runtime.lastDisconnect,
    };
  }

  private viewOfRow(row: SessionRow): SessionView {
    return {
      sessionId: row.id,
      status: row.status,
      phone: row.phone,
      qr: null,
      connectedAt: row.lastConnectedAt?.toISOString() ?? null,
      lastDisconnect: row.lastDisconnectCode !== null || row.lastDisconnectReason !== null
        ? { code: row.lastDisconnectCode, reason: row.lastDisconnectReason }
        : null,
    };
  }

  private clearTimers(runtime: Runtime): void {
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer);
    if (runtime.stableTimer) clearTimeout(runtime.stableTimer);
    runtime.reconnectTimer = null;
    runtime.stableTimer = null;
  }

  private requireActive(): void {
    if (!this.active) throw errors.notReady();
  }

  private requireValidId(sessionId: string): void {
    if (!SESSION_ID.test(sessionId)) {
      throw new GatewayError('invalid_session_id', 'Session ids are 8 to 64 characters: letters, digits, "_" and "-".', 422);
    }
  }
}
