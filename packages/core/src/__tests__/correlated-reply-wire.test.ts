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
import { BUS_OPERATIONS } from '../bus-operations';
import { CHANNEL_SCHEMAS } from '../bus-protocol';

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

  /**
   * The invariant that binds FUTURE progress producers, and the reason this is
   * a gate rather than three field checks.
   *
   * `CORRELATED_CHANNELS` derives progress channels into the delivery filter
   * automatically. A progress channel whose payload carries no `correlationId`
   * therefore ships frames the filter cannot match and silently drops — a new
   * channel would inherit the bug with nothing to catch it.
   */
  it('every operation progress channel requires correlationId', () => {
    const ops = BUS_OPERATIONS as Record<string, { result: string; failure: string; progress?: string }>;
    const channels = CHANNEL_SCHEMAS as Record<string, string | null>;

    const offenders: string[] = [];
    for (const [op, spec] of Object.entries(ops)) {
      if (!spec.progress) continue;
      const schemaName = channels[spec.progress];
      if (!schemaName) {
        offenders.push(`${op} → ${spec.progress} (no schema: a progress frame with no payload cannot be routed)`);
        continue;
      }
      if (!(schema(schemaName).required ?? []).includes('correlationId')) {
        offenders.push(`${op} → ${spec.progress} (${schemaName} does not require correlationId)`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('covers at least one progress channel — a vacuous pass would mean the registry moved', () => {
    const ops = BUS_OPERATIONS as Record<string, { progress?: string }>;
    expect(Object.values(ops).filter((o) => o.progress).length).toBeGreaterThan(0);
  });
});
