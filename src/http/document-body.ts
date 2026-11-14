import { z } from 'zod';
import type { OutboundDocument } from '../engine/types.js';
import { errors } from '../lib/errors.js';

/** A result sheet is a few hundred KB. This leaves room without letting the gateway be used to move big files. */
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
/** Base64 is a third larger than the bytes it carries, plus the rest of the JSON. */
export const MAX_DOCUMENT_REQUEST_BYTES = Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 16 * 1024;

const PDF_MAGIC = '%PDF-';
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()'&,-]{0,118}\.pdf$/i;

export const documentBody = z
  .object({
    to: z.string().min(1).max(64),
    fileName: z.string().min(5).max(124).regex(SAFE_FILE_NAME, 'fileName must be a plain name ending in .pdf'),
    mimeType: z.literal('application/pdf'),
    /** The file, base64-encoded. */
    data: z.string().min(8).max(Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 1024).regex(BASE64, 'data must be base64'),
    caption: z.string().min(1).max(1024).optional(),
    idempotencyKey: z.string().min(8).max(128).optional(),
  })
  .strict();

export type DocumentBody = z.infer<typeof documentBody>;

/** Turns the request into a file to send, refusing anything that isn't really a PDF of a sensible size. */
export function decodeDocument(body: DocumentBody): OutboundDocument {
  const data = Buffer.from(body.data, 'base64');
  if (data.length === 0) throw errors.invalidDocument('The document is empty.');
  if (data.length > MAX_DOCUMENT_BYTES) throw errors.invalidDocument('The document is too large.');
  if (data.subarray(0, PDF_MAGIC.length).toString('latin1') !== PDF_MAGIC) throw errors.invalidDocument('The document is not a PDF.');
  return { data, fileName: body.fileName, mimeType: body.mimeType, ...(body.caption ? { caption: body.caption } : {}) };
}
