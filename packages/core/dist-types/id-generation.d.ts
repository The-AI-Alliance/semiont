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
/**
 * Generate a UUID v4 string WITHOUT dashes (32 hex chars).
 *
 * The dashless form is data shape: persisted annotation/resource/job ids are
 * built from it and land in URIs. Do not change the format.
 */
export declare function generateUuid(): string;
/**
 * Generate a canonical dashed UUID v4 (36 chars, 8-4-4-4-12) — the format
 * `crypto.randomUUID()` produces, without its secure-context requirement.
 *
 * Use for ephemeral wire ids (`correlationId`s and the like).
 */
export declare function uuidV4(): string;
