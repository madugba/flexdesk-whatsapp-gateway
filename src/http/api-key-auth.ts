import { createHash, timingSafeEqual } from 'node:crypto';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/**
 * Checks a bearer token against the configured keys in constant time. Hashing first makes
 * every comparison the same length, so neither the key's length nor its prefix leaks.
 */
export function createApiKeyVerifier(keys: string[]): (authorization: string | undefined) => boolean {
  const hashes = keys.map(sha256);
  return (authorization) => {
    const match = /^Bearer (.+)$/.exec(authorization ?? '');
    if (!match?.[1]) return false;
    const provided = sha256(match[1]);
    return hashes.reduce((ok, hash) => timingSafeEqual(hash, provided) || ok, false);
  };
}
