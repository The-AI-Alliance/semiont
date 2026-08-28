/**
 * `makeMeaningConfigFrom` — the one mapping from EnvironmentConfig.
 *
 * It exists because two actors need the identical slice (the gateway's
 * `startMakeMeaning` and the Archivist's `archivist-main`), and two copies
 * would drift. Its two throws are the interesting part: `gather` and `search`
 * defaults belong to the TOML loader (D5), so a config arriving without them
 * bypassed the loader — and this refuses rather than quietly substituting a
 * second default, which is how two defaults for one value get born.
 */

import { describe, it, expect } from 'vitest';
import type { EnvironmentConfig } from '@semiont/core';
import { makeMeaningConfigFrom } from '../config';

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

  it('refuses a config that bypassed the loader — no gather bound', () => {
    // Defaulting here would create a SECOND owner of settleTimeoutMs, and the
    // two would disagree the first time either moved.
    expect(() => makeMeaningConfigFrom(loaded({ gather: undefined })))
      .toThrow(/gather config missing.*loadEnvironmentConfig/s);
  });

  it('refuses a config that bypassed the loader — no search floor', () => {
    expect(() => makeMeaningConfigFrom(loaded({ search: undefined })))
      .toThrow(/search config missing.*loadEnvironmentConfig/s);
  });

  it('refuses when `_metadata` is absent entirely', () => {
    // The shape a hand-built config takes — the failure names the loader
    // rather than a missing property, because that is the actionable fact.
    expect(() => makeMeaningConfigFrom({ services: SERVICES } as unknown as EnvironmentConfig))
      .toThrow(/loadEnvironmentConfig/);
  });

  it('passes the site domain through when present, and omits it when not', () => {
    // The KB's canonical identity — the agent roster mints DIDs from this, and
    // it must be the same value /api/tokens/agent uses.
    const withSite = makeMeaningConfigFrom({
      ...loaded(), site: { domain: 'kb.example.org' },
    } as unknown as EnvironmentConfig);
    expect(withSite.site?.domain).toBe('kb.example.org');
    expect(makeMeaningConfigFrom(loaded()).site).toBeUndefined();
  });
});
