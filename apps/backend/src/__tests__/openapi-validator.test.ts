/**
 * The validator's compile surface — every schema in the bundle, eagerly.
 *
 * Ajv accepts schemas at addSchema() time WITHOUT compiling them; compilation
 * happens lazily inside validateSchema() on the first request for a channel,
 * and a compile error there escapes as a 500 on every emit for that channel,
 * valid payloads included. That is how a `discriminator` added to
 * AnnotationBody.json broke POST /bus/emit for mark:create at request time
 * with nothing at build or load time noticing (PR #1189's Backend Tests run).
 *
 * This test walks the whole components.schemas map through validateSchema so
 * any keyword or structure Ajv cannot compile — anywhere in the spec, whether
 * or not a validated channel reaches it yet — fails HERE, deterministically,
 * naming the schema.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { validateSchema } from '../utils/openapi-validator';
import { initializeLogger } from '../logger';
import openapiSpec from '../../../../specs/openapi.json';

describe('openapi-validator compiles the entire spec', () => {
  beforeAll(() => {
    initializeLogger('error');
  });

  it('compiles every registered component schema without throwing', () => {
    const failures: string[] = [];
    for (const name of Object.keys(openapiSpec.components.schemas)) {
      try {
        // The verdict is irrelevant — {} may validly fail. Only a compile
        // error throws, and a throw is the request-time 500.
        validateSchema(name, {});
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
