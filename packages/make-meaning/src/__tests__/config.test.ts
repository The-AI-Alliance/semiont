/**
 * `makeMeaningConfigFrom` — the one mapping from EnvironmentConfig.
 *
 * One mapping, so every service that reads the slice reads the same one.
 * Its two throws are the interesting part: `gather` and `search`
 * defaults belong to the TOML loader, so a config arriving without them
 * bypassed the loader — and this refuses rather than quietly substituting a
 * second default, which is how two defaults for one value get born.
 */

import { describe, it, expect } from 'vitest';
import type { EnvironmentConfig } from '@semiont/core';
import { makeMeaningConfigFrom, requireKBName } from '../config';

const SERVICES = {
  graph: { platform: { type: 'posix' }, type: 'memory' },
  vectors: { type: 'memory' },
  embedding: { type: 'ollama', model: 'nomic-embed-text' },
};

/** What the TOML loader produces: `gather`/`search` live under `_metadata`. */
function loaded(over: Record<string, unknown> = {}): EnvironmentConfig {
  return {
    services: SERVICES,
    _metadata: {
      gather: { settleTimeoutMs: 15_000 },
      search: { semanticFloor: 0.6 },
      ...over,
    },
  } as unknown as EnvironmentConfig;
}

describe('makeMeaningConfigFrom', () => {
  it('carries the loader-owned gather and search bounds through', () => {
    const config = makeMeaningConfigFrom(loaded());
    expect(config.gather.settleTimeoutMs).toBe(15_000);
    expect(config.search.semanticFloor).toBe(0.6);
  });

  it('maps the three service sections', () => {
    const config = makeMeaningConfigFrom(loaded());
    expect(config.services.graph).toEqual(SERVICES.graph);
    expect(config.services.vectors).toEqual(SERVICES.vectors);
    expect(config.services.embedding).toEqual(SERVICES.embedding);
  });

  // A service reads only the config sections it declares, and the loader
  // refuses a read of any other: the view copies nothing at construction, and
  // each part is read from the loaded config only when the service reads it.
  it('reads nothing at construction, and delegates each part at its read', () => {
    const reads: string[] = [];
    const part = <T>(name: string, value: T) => () => { reads.push(name); return value; };
    const services = {} as Record<string, unknown>;
    for (const [name, value] of Object.entries({ graph: SERVICES.graph, vectors: SERVICES.vectors, embedding: SERVICES.embedding, archivist: { host: 'a' } })) {
      Object.defineProperty(services, name, { get: part(name, value), enumerable: true });
    }
    const meta = {} as Record<string, unknown>;
    for (const [name, value] of Object.entries({ gather: { settleTimeoutMs: 1 }, search: { semanticFloor: 0.5 }, actors: { matcher: undefined } })) {
      Object.defineProperty(meta, name, { get: part(name, value), enumerable: true });
    }
    const config = makeMeaningConfigFrom({ services, _metadata: meta } as unknown as EnvironmentConfig);
    expect(reads).toEqual([]);
    expect(config.services.archivist).toEqual({ host: 'a' });
    expect(config.actors).toEqual({ matcher: undefined });
    expect(reads).toEqual(['archivist', 'actors']);
  });

  it('refuses a config that bypassed the loader — no gather bound', () => {
    // Defaulting here would create a SECOND owner of settleTimeoutMs, and the
    // two would disagree the first time either moved.
    expect(() => makeMeaningConfigFrom(loaded({ gather: undefined })).gather)
      .toThrow(/gather config missing.*loadEnvironmentConfig/s);
  });

  it('refuses a config that bypassed the loader — no search floor', () => {
    expect(() => makeMeaningConfigFrom(loaded({ search: undefined })).search)
      .toThrow(/search config missing.*loadEnvironmentConfig/s);
  });

  it('refuses when `_metadata` is absent entirely', () => {
    // The shape a hand-built config takes — the failure names the loader
    // rather than a missing property, because that is the actionable fact.
    expect(() => makeMeaningConfigFrom({ services: SERVICES } as unknown as EnvironmentConfig).gather)
      .toThrow(/loadEnvironmentConfig/);
  });
});

// The Librarian has no /kb mount, so the KB name — the one committed fact it
// needs, to find the views the Archivist materializes — arrives as `[kb] name`,
// staged by the launcher. Boot refuses without it: a defaulted name would
// compose a state path nobody writes to, and the Librarian would answer every
// match from an empty view store forever.
describe('requireKBName', () => {
  it('returns the staged name', () => {
    const config = { ...loaded(), kb: { name: 'example-kb' } } as unknown as EnvironmentConfig;
    expect(requireKBName(config)).toBe('example-kb');
  });

  it('refuses to proceed without one, naming the key and who stages it', () => {
    expect(() => requireKBName(loaded())).toThrow(/\[kb\] name.*launcher/s);
  });
});
