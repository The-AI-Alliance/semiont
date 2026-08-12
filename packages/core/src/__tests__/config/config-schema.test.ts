/**
 * Schema-semantics guard — MANDATORY-EMBEDDING P1 (D0 + D1).
 *
 * Semantic search is always available, so a config must NAME both a vector
 * store and an embedding provider — nothing is defaulted, and a config
 * missing either section must fail schema validation with an actionable
 * error (the explicit-opt-in decision, D1). The schema is consumed by
 * codegen and by downstream validators; this test pins its SEMANTICS with
 * ajv (already a core dependency) so the requirement exists independent of
 * any one validator's wiring.
 *
 * RED before P1's schema change: `ServicesConfig` had no `required` array at
 * all, so a bare `{}` validated. Green after.
 */
import { describe, it, expect } from 'vitest';
import { Ajv } from 'ajv';
import * as fs from 'fs';
import * as path from 'path';

const schema: object = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../config/config.schema.json'), 'utf8'),
);

const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(schema, 'cfg');
const validate = ajv.getSchema('cfg#/definitions/ServicesConfig');
if (!validate) throw new Error('ServicesConfig definition not found in config.schema.json');

const VECTORS = { type: 'qdrant', host: 'localhost', port: 6333 };
const EMBEDDING = { type: 'ollama', model: 'nomic-embed-text' };

describe('config schema — vectors and embedding are mandatory, explicitly (D0+D1)', () => {
  it('a services section naming both validates', () => {
    expect(validate({ vectors: VECTORS, embedding: EMBEDDING })).toBe(true);
  });

  it('memory is a first-class named store choice, not a fallback', () => {
    expect(validate({ vectors: { type: 'memory' }, embedding: EMBEDDING })).toBe(true);
  });

  it('a services section missing vectors fails validation', () => {
    expect(validate({ embedding: EMBEDDING })).toBe(false);
  });

  it('a services section missing embedding fails validation', () => {
    expect(validate({ vectors: VECTORS })).toBe(false);
  });

  it('an empty services section fails validation, naming both gaps', () => {
    expect(validate({})).toBe(false);
    const missing = (validate.errors ?? [])
      .filter((e) => e.keyword === 'required')
      .map((e) => (e.params as { missingProperty?: string }).missingProperty);
    expect(missing).toContain('vectors');
    expect(missing).toContain('embedding');
  });

  it('a vectors section cannot omit its type — the store must be NAMED', () => {
    expect(validate({ vectors: { host: 'localhost' }, embedding: EMBEDDING })).toBe(false);
  });
});
