/**
 * The wire carries identity.
 *
 * One field has to exist, on both bus request bodies, before the gateway can
 * route a reply to the one client that asked for it: `clientId`. The schemas
 * carry it; the gateway's reply filter, which writes a correlated reply only
 * to its owner's connections, is what reads it.
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

describe('the wire carries identity', () => {
  it('BusSubscribeRequest REQUIRES clientId', () => {
    // Required, not optional: a subscriber without one could never receive a
    // correlated frame, and that has to fail loudly at subscribe rather than
    // silently at delivery.
    const s = schema('BusSubscribeRequest');
    expect(s.properties).toHaveProperty('clientId');
    expect(s.required ?? []).toContain('clientId');
  });

  it('BusEmitRequest carries clientId, optionally', () => {
    // Optional in the schema because plain broadcasts need no return address;
    // the ROUTE enforces it for a registry operation's request emitted with a
    // correlationId. A schema-level requirement would reject every
    // legitimate broadcast emit.
    const s = schema('BusEmitRequest');
    expect(s.properties).toHaveProperty('clientId');
    expect(s.required ?? []).not.toContain('clientId');
  });

  it('clientId is a top-level wire field on emit, never inside the payload', () => {
    // It is a routing concern like `scope`, not part of any channel's domain
    // payload — burying it in the payload would put a routing address into
    // every consumer's typed event.
    const s = schema('BusEmitRequest');
    expect(Object.keys(s.properties ?? {})).toEqual(
      expect.arrayContaining(['channel', 'payload', 'scope', 'clientId']),
    );
  });
});
