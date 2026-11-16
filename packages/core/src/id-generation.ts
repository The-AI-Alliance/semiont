/**
 * ID generation utilities.
 *
 * Built on `crypto.getRandomValues()`, NOT `crypto.randomUUID()`: browsers
 * expose `randomUUID` only in secure contexts (https, `http://localhost`,
 * `http://127.0.0.1`), so a page served over plain http from any other host
 * has no `randomUUID` and calling it throws — which broke the frontend from
 * the host-gateway IP (.plans/bugs/crypto-randomuuid-insecure-context.md).
 * `getRandomValues` is cryptographically sound and available in ALL contexts,
 * Node and browser, secure or not.
 */

// Declared here because the core package tsconfig uses lib:ES2022 (no dom types).
declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };

function v4Bytes(): Uint8Array {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a UUID v4 string WITHOUT dashes (32 hex chars).
 *
 * The dashless form is data shape: persisted annotation/resource/job ids are
 * built from it and land in URIs. Do not change the format.
 */
export function generateUuid(): string {
  return hex(v4Bytes());
}

/**
 * Generate a canonical dashed UUID v4 (36 chars, 8-4-4-4-12) — the format
 * `crypto.randomUUID()` produces, without its secure-context requirement.
 *
 * Use for ephemeral wire ids (`correlationId`s and the like).
 */
export function uuidV4(): string {
  const h = hex(v4Bytes());
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
