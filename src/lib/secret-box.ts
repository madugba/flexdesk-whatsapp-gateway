import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/**
 * AES-256-GCM encryption for data at rest. Each ciphertext is bound to a context
 * string (for example the session id and key id of its row), so a value copied to a
 * different row fails authentication instead of decrypting.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(masterKeyBase64: string) {
    const master = Buffer.from(masterKeyBase64, 'base64');
    if (master.length !== 32) throw new Error('Encryption key must be 32 bytes');
    this.key = Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'flexdesk-whatsapp-gateway/v1/at-rest', 32));
  }

  seal(plaintext: Uint8Array, context: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
  }

  open(sealed: Uint8Array, context: string): Buffer {
    const data = Buffer.from(sealed);
    if (data.length < HEADER_BYTES || data[0] !== VERSION) throw new Error('Unsupported ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(1, 1 + IV_BYTES));
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(data.subarray(1 + IV_BYTES, HEADER_BYTES));
    return Buffer.concat([decipher.update(data.subarray(HEADER_BYTES)), decipher.final()]);
  }
}
