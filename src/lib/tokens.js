import crypto from 'node:crypto';

/** URL-safe random token (256 bits) and its SHA-256 hash for storage. */
export function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
