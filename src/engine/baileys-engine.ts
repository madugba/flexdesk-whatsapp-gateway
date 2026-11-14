import makeWASocket, { Browsers, makeCacheableSignalKeyStore } from '@whiskeysockets/baileys';
import type { CacheStore, WASocket } from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import type { Logger } from '../lib/logger.js';
import type { LoadedAuthState, PostgresAuthStore } from './auth-state.js';
import { classifyDisconnect } from './disconnect.js';
import { phoneFromJid } from './jid.js';
import { extractInbound } from './message-extract.js';
import type { Engine, EngineEvent, EngineFactory, InboundMessage, OutboundDocument } from './types.js';

const RETRY_CACHE_LIMIT = 1_000;

/** A small bounded cache for Baileys' message-retry counters. */
function createRetryCache(): CacheStore {
  const entries = new Map<string, unknown>();
  return {
    get: <T>(key: string) => entries.get(key) as T | undefined,
    set: (key, value) => {
      if (entries.size >= RETRY_CACHE_LIMIT) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      entries.set(key, value);
    },
    del: (key) => entries.delete(key),
    flushAll: () => entries.clear(),
  };
}

export interface BaileysEngineOptions {
  /** Override WhatsApp's WebSocket endpoint. Used by tests; leave unset in production. */
  waWebSocketUrl?: string;
}

/**
 * Thin adapter between one Baileys socket and the gateway's engine interface. It holds no
 * policy: reconnecting, rate limiting and the reply window live in the session manager.
 * A closed socket is never reused; the manager asks the factory for a fresh engine.
 */
export class BaileysEngine implements Engine {
  private socket: WASocket | null = null;
  private listener: (event: EngineEvent) => void = () => undefined;
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly auth: LoadedAuthState,
    private readonly logger: Logger,
    private readonly options: BaileysEngineOptions,
  ) {}

  onEvent(listener: (event: EngineEvent) => void): void {
    this.listener = listener;
  }

  async start(): Promise<void> {
    const socketLogger = this.logger.child({ component: 'baileys', sessionId: this.sessionId }, { level: 'warn' });
    const socket = makeWASocket({
      auth: { creds: this.auth.state.creds, keys: makeCacheableSignalKeyStore(this.auth.state.keys, socketLogger) },
      logger: socketLogger,
      browser: Browsers.ubuntu('Chrome'),
      // Never ask for the full chat history. Baileys' default still processes the small initial
      // syncs it needs for phone-number/LID mappings; blocking those is unsafe.
      syncFullHistory: false,
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false,
      emitOwnEvents: false,
      msgRetryCounterCache: createRetryCache(),
      getMessage: async () => undefined,
      shouldIgnoreJid: (jid) => !jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid'),
      ...(this.options.waWebSocketUrl ? { waWebSocketUrl: this.options.waWebSocketUrl } : {}),
    });
    this.socket = socket;

    socket.ev.on('creds.update', () => {
      this.auth.saveCreds().catch((error: unknown) => this.logger.error({ error, sessionId: this.sessionId }, 'Saving credentials failed'));
    });

    socket.ev.on('connection.update', (update) => {
      if (this.closed) return;
      if (update.qr) this.emit({ type: 'qr', qr: update.qr });
      if (update.connection === 'open') {
        this.emit({ type: 'open', phone: phoneFromJid(socket.user?.id) ?? phoneFromJid(socket.user?.phoneNumber) });
      }
      if (update.connection === 'close') {
        this.closed = true;
        const error = update.lastDisconnect?.error as Boom | undefined;
        const code = error?.output?.statusCode;
        this.emit({
          type: 'close',
          code,
          reason: error?.message ?? 'Connection closed',
          disposition: classifyDisconnect(code, Boolean(this.auth.state.creds.me)),
        });
      }
    });

    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (this.closed || type !== 'notify') return;
      for (const raw of messages) {
        const message = extractInbound(raw);
        if (message) this.emit({ type: 'message', message });
      }
    });
  }

  private emit(event: EngineEvent): void {
    try {
      this.listener(event);
    } catch (error) {
      this.logger.error({ error, sessionId: this.sessionId, eventType: event.type }, 'Engine event handler failed');
    }
  }

  private requireSocket(): WASocket {
    if (!this.socket || this.closed) throw new Error('WhatsApp connection is not open');
    return this.socket;
  }

  async sendPresence(chatId: string, presence: 'composing' | 'paused'): Promise<void> {
    await this.requireSocket().sendPresenceUpdate(presence, chatId);
  }

  async sendText(chatId: string, text: string): Promise<{ messageId: string }> {
    const sent = await this.requireSocket().sendMessage(chatId, { text });
    const messageId = sent?.key.id;
    if (!messageId) throw new Error('WhatsApp did not return a message id');
    return { messageId };
  }

  async sendDocument(chatId: string, document: OutboundDocument): Promise<{ messageId: string }> {
    const sent = await this.requireSocket().sendMessage(chatId, {
      document: document.data,
      mimetype: document.mimeType,
      fileName: document.fileName,
      ...(document.caption ? { caption: document.caption } : {}),
    });
    const messageId = sent?.key.id;
    if (!messageId) throw new Error('WhatsApp did not return a message id');
    return { messageId };
  }

  async markRead(message: Pick<InboundMessage, 'messageId' | 'chatId'>): Promise<void> {
    await this.requireSocket().readMessages([{ remoteJid: message.chatId, id: message.messageId, fromMe: false }]);
  }

  async logout(): Promise<void> {
    const socket = this.socket;
    this.closed = true;
    if (socket) await socket.logout().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.socket?.end(undefined);
    this.socket = null;
  }
}

export class BaileysEngineFactory implements EngineFactory {
  constructor(
    private readonly store: PostgresAuthStore,
    private readonly logger: Logger,
    private readonly options: BaileysEngineOptions = {},
  ) {}

  async create(sessionId: string): Promise<Engine> {
    const auth = await this.store.load(sessionId);
    return new BaileysEngine(sessionId, auth, this.logger, this.options);
  }
}
