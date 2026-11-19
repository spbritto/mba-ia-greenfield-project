import { randomBytes } from 'node:crypto';

/**
 * Generates a 12-character base64url public ID.
 * 9 random bytes → 12 base64url characters (alphabet: [A-Za-z0-9_-]).
 */
export function generatePublicId(): string {
  return randomBytes(9).toString('base64url');
}
