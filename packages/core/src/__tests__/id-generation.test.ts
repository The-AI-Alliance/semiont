/**
 * ID generation must not depend on `crypto.randomUUID` — browsers expose it
 * only in SECURE contexts (https, localhost, 127.0.0.1). A page served over
 * plain http from any other host (the launcher's host-gateway IP, a LAN
 * address) has `crypto.getRandomValues` but NOT `crypto.randomUUID`, and the
 * frontend died on its first correlationId there
 * (.plans/bugs/crypto-randomuuid-insecure-context.md).
 *
 * These tests run every helper under exactly that environment: a `crypto`
 * global with `getRandomValues` and nothing else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateUuid, uuidV4 } from '../id-generation';

const DASHLESS_V4 = /^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/;
const DASHED_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('id generation in an insecure browsing context (no crypto.randomUUID)', () => {
  beforeEach(() => {
    // The insecure-context shape: getRandomValues present, randomUUID absent.
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: real.getRandomValues.bind(real),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the stub reproduces the broken environment', () => {
    expect(crypto.getRandomValues).toBeTypeOf('function');
    expect((crypto as { randomUUID?: unknown }).randomUUID).toBeUndefined();
  });

  it('generateUuid() works and keeps the dashless 32-hex v4 data shape', () => {
    const id = generateUuid();
    expect(id).toMatch(DASHLESS_V4);
  });

  it('uuidV4() works and produces the canonical dashed v4 wire shape', () => {
    const id = uuidV4();
    expect(id).toMatch(DASHED_V4);
  });

  it('ids are distinct across calls', () => {
    const ids = new Set([
      ...Array.from({ length: 64 }, () => generateUuid()),
      ...Array.from({ length: 64 }, () => uuidV4()),
    ]);
    expect(ids.size).toBe(128);
  });
});
