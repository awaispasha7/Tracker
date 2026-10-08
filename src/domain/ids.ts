import { createHash, randomBytes } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Registrations are reported as "N-123AB", "n123ab", "G-LXJT"... compare them without separators. */
export function normalizeTail(tail: string): string {
  return tail.trim().toUpperCase().replace(/[\s-]/g, '');
}
