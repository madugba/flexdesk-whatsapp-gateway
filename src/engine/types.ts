export type SessionStatus =
  | 'connecting'
  | 'qr'
  | 'open'
  | 'reconnecting'
  | 'logged_out'
  | 'replaced'
  | 'qr_expired'
  | 'error';

export interface InboundMessage {
  messageId: string;
  /** The exact chat address to reply to. Always use this, not `phone`, when replying. */
  chatId: string;
  /** Sender's phone number in international digits, or null when WhatsApp hides it. */
  phone: string | null;
  pushName: string | null;
  /** Unix seconds. */
  timestamp: number;
  type: 'text' | 'unsupported';
  text: string | null;
}

export type DisconnectDisposition =
  /** Transient failure: reconnect after a backoff. */
  | 'reconnect'
  /** WhatsApp asked for a restart (normal right after pairing): reconnect at once. */
  | 'reconnect_now'
  /** The user removed the linked device or the account was logged out. */
  | 'logged_out'
  /** Another client took over this session. Reconnecting would start a fight. */
  | 'replaced'
  /** The stored session is unusable and must be linked again. */
  | 'relink'
  /** The QR code expired before it was scanned. */
  | 'qr_expired';

export type EngineEvent =
  | { type: 'qr'; qr: string }
  | { type: 'open'; phone: string | null }
  | { type: 'close'; code: number | undefined; reason: string; disposition: DisconnectDisposition }
  | { type: 'message'; message: InboundMessage };

/** A file to send. Held in memory only; the gateway never stores it. */
export interface OutboundDocument {
  data: Buffer;
  fileName: string;
  mimeType: 'application/pdf';
  caption?: string;
}

export interface Engine {
  start(): Promise<void>;
  onEvent(listener: (event: EngineEvent) => void): void;
  sendPresence(chatId: string, presence: 'composing' | 'paused'): Promise<void>;
  sendText(chatId: string, text: string): Promise<{ messageId: string }>;
  sendDocument(chatId: string, document: OutboundDocument): Promise<{ messageId: string }>;
  markRead(message: Pick<InboundMessage, 'messageId' | 'chatId'>): Promise<void>;
  /** Unlinks the device at WhatsApp. */
  logout(): Promise<void>;
  /** Closes the connection without unlinking, so the session can be resumed later. */
  stop(): Promise<void>;
}

export interface EngineFactory {
  create(sessionId: string): Promise<Engine>;
}
