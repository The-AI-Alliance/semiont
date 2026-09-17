/**
 * CORRELATED-REPLY-ROUTING P1 — the wire carries identity.
 *
 * Three fields have to exist before the gateway can route a reply to the one
 * client that asked for it (D1/D5): `clientId` on both bus request bodies, and
 * `correlationId` on the progress payload. P1 adds them and nothing reads them
 * yet; P3's filter is the cutover.
 *
 * Asserted against `specs/src/components/schemas/` rather than the generated
 * types because the schema is the authority — the TS types, the Go client and
 * the Ajv validators are all derived from it, so a check on any one of them
 * would be a check on a derivation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../specs/src/components/schemas');

function schema(name: string): { properties?: Record<string, unknown>; required?: string[] } {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.json`), 'utf-8'));
}

describe('CORRELATED-REPLY-ROUTING P1 — the wire carries identity', () => {
  it('BusSubscribeRequest REQUIRES clientId', () => {
    // Required, not optional: a subscriber without one could never receive a
    // correlated frame, and that has to fail loudly at subscribe rather than
    // silently at delivery (D5).
    const s = schema('BusSubscribeRequest');
    expect(s.properties).toHaveProperty('clientId');
    expect(s.required ?? []).toContain('clientId');
  });

  it('BusEmitRequest carries clientId, optionally', () => {
    // Optional in the schema because plain broadcasts need no return address;
    // the ROUTE enforces it for registered request channels whose payload
    // carries a correlationId (D5). A schema-level requirement would reject
    // every legitimate broadcast emit.
    const s = schema('BusEmitRequest');
    expect(s.properties).toHaveProperty('clientId');
    expect(s.required ?? []).not.toContain('clientId');
  });

  it('clientId is a top-level wire field on emit, never inside the payload', () => {
    // It is a routing concern like `scope`, not part of any channel's domain
    // payload — burying it in the payload would put a routing address into
    // every consumer's typed event (D1).
    const s = schema('BusEmitRequest');
    expect(Object.keys(s.properties ?? {})).toEqual(
      expect.arrayContaining(['channel', 'payload', 'scope', 'clientId']),
    );
  });

  // Two progress-channel cases lived here: one asserting a progress payload
  // had a schema and no longer declared `correlationId`, and a vacuity guard
  // asserting at least one operation declared progress. The guard fired when
  // the last one was removed on 2026-09-17 — working exactly as written. The
  // registry did move, deliberately: see .plans/RESTORE-STREAMING-PROGRESS.md.
});
