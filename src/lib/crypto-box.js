/**
 * Authenticated encryption for files at rest (AES-256-GCM).
 * The key comes from FILE_ENCRYPTION_KEY (32 random bytes, base64) and never
 * touches the database, so a database dump or backup alone does not expose
 * document photos. The record id is bound as additional authenticated data,
 * so ciphertext cannot be swapped between rows undetected.
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { AppError } from './errors.js';

export const KEY_VERSION = 1;

function key() {
  if (!config.fileEncryptionKey) {
    throw new AppError(503, 'FEATURE_DISABLED', 'Document photos are not enabled on this server');
  }
  return config.fileEncryptionKey;
}

export function encrypt(plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(Buffer.from(String(aad)));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, authTag: cipher.getAuthTag(), data, keyVersion: KEY_VERSION };
}

export function decrypt({ iv, authTag, data }, aad) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAAD(Buffer.from(String(aad)));
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new AppError(500, 'DECRYPT_FAILED', 'This file could not be decrypted');
  }
}
