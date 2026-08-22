/**
 * Spec validators — GRAPH-ANNOTATION-CODEC P4 (D8 = generate).
 *
 * There is exactly one ajv-over-the-spec validator in the repo. It used to live
 * in `apps/backend`, where `/bus/emit` could reach it and nothing else could;
 * make-meaning's P3 teeth need the same one, and a second setup would
 * hand-restate its semantics (3.0 `nullable` → draft-07, the
 * `example`/`discriminator` allowlist, `coerceTypes`, formats) — a drift in any
 * of them yields a teeth test that cannot bite.
 *
 * Generated at build time over every component schema, so the validators and
 * the `components['schemas']` types come from one bundle and cannot disagree.
 */
import { describe, it, expect } from 'vitest';
import { validators, formatErrors } from '../openapi';

describe('generated spec validators', () => {
  it('accepts a well-formed request body', () => {
    expect(validators.CreateAnnotationRequest({
      target: { source: 'res-1' },
      motivation: 'linking',
    })).toBe(true);
  });

  it('rejects a malformed body and says what is wrong', () => {
    const validate = validators.CreateAnnotationRequest;
    expect(validate({ motivation: 'linking' })).toBe(false);
    expect(formatErrors(validate.errors)).toMatch(/required|target/i);
  });

  it('validates a discriminated union member — the shape that broke /bus/emit', () => {
    // `discriminator` is allowlisted as annotation-only, so the sibling oneOf
    // stays the validation authority (OpenAPI's own semantics for it).
    expect(validators.AnnotationBody({
      type: 'TextualBody',
      value: 'Person',
      purpose: 'tagging',
    })).toBe(true);
  });

  it('validates the OpenAPI 3.0 nullable-$ref idiom (nullable beside allOf)', () => {
    // Five schemas use it. Left unconverted, Ajv refuses the schema outright —
    // which is now a build failure rather than a 500 on first use.
    expect(validators.BrowseAnchoredTextResult({
      correlationId: 'c-1',
      response: { kind: 'declined', declined: 'no-text-layer' },
    })).toBe(true);
    expect(validators.BrowseAnchoredTextResult({
      correlationId: 'c-1',
      response: null,
    })).toBe(true);
  });

  it('covers every component schema, so no consumer needs a fallback', () => {
    // The generated set is EVERY schema, not the bus registry's `validate`
    // subset — route bodies are validated by name and have no registry entry.
    expect(Object.keys(validators).length).toBeGreaterThan(200);
    expect(typeof validators.GatheredContext).toBe('function');
  });
});
