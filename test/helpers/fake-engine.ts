import type { Engine, EngineEvent, EngineFactory, InboundMessage, OutboundDocument } from '../../src/engine/types.js';

export class FakeEngine implements Engine {
  listener: (event: EngineEvent) => void = () => undefined;
  started = false;
  stopped = false;
  loggedOut = false;
  sent: Array<{ chatId: string; text: string }> = [];
  documents: Array<{ chatId: string; document: OutboundDocument }> = [];
  presences: string[] = [];
  read: string[] = [];
  failNextSend = false;
  private counter = 0;

  constructor(readonly sessionId: string) {}

  async start() {
    this.started = true;
  }
  onEvent(listener: (event: EngineEvent) => void) {
    this.listener = listener;
  }
  async sendPresence(chatId: string, presence: 'composing' | 'paused') {
    this.presences.push(`${presence}:${chatId}`);
  }
  async sendText(chatId: string, text: string) {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('boom');
    }
    this.sent.push({ chatId, text });
    return { messageId: `${this.sessionId}-out-${++this.counter}` };
  }
  async sendDocument(chatId: string, document: OutboundDocument) {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error('boom');
    }
    this.documents.push({ chatId, document });
    return { messageId: `${this.sessionId}-doc-${++this.counter}` };
  }
  async markRead(message: Pick<InboundMessage, 'messageId'>) {
    this.read.push(message.messageId);
  }
  async logout() {
    this.loggedOut = true;
  }
  async stop() {
    this.stopped = true;
  }

  emit(event: EngineEvent) {
    this.listener(event);
  }
}

export class FakeEngineFactory implements EngineFactory {
  readonly created: FakeEngine[] = [];
  failCreate = false;

  async create(sessionId: string) {
    if (this.failCreate) throw new Error('cannot create');
    const engine = new FakeEngine(sessionId);
    this.created.push(engine);
    return engine;
  }

  latest(sessionId: string): FakeEngine {
    const engine = [...this.created].reverse().find((candidate) => candidate.sessionId === sessionId);
    if (!engine) throw new Error(`no engine for ${sessionId}`);
    return engine;
  }
}

export const eventually = async (check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Condition not met in time');
};
