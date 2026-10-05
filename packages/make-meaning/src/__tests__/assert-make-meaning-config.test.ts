import { describe, it, expect } from 'vitest';
import { STALL_THRESHOLD_MS } from '@semiont/jobs';
import { assertMakeMeaningConfig } from '../assert-make-meaning-config';
import type { MakeMeaningConfig } from '../config';

const config: MakeMeaningConfig = {
  gather: { settleTimeoutMs: 15_000 }, search: { semanticFloor: 0.6 },
  services: {
    graph: { platform: { type: 'posix' }, type: 'memory' },
    vectors: { type: 'memory' },
    embedding: { type: 'ollama', model: 'nomic-embed-text' },
  },
};

describe('assertMakeMeaningConfig', () => {
  it('accepts a config that names a graph and a nested settle bound', () => {
    expect(() => assertMakeMeaningConfig(config)).not.toThrow();
  });

  it('rejects a config naming no graph service', () => {
    // The schema requires the other two service sections, so the TOML loader
    // turns those away first. `graph` it does not, so the refusal is here.
    const bad = { ...config, services: { ...config.services, graph: undefined } } as MakeMeaningConfig;
    expect(() => assertMakeMeaningConfig(bad)).toThrow(/services\.graph is required/);
  });

  it('rejects a settle bound that cannot degrade before the stall watchdog fails fast', () => {
    const bad: MakeMeaningConfig = { ...config, gather: { settleTimeoutMs: STALL_THRESHOLD_MS } };
    expect(() => assertMakeMeaningConfig(bad)).toThrow(/settleTimeoutMs.*stall watchdog/);
  });

  it('rejects a non-positive settle bound', () => {
    const bad: MakeMeaningConfig = { ...config, gather: { settleTimeoutMs: 0 } };
    expect(() => assertMakeMeaningConfig(bad)).toThrow(/settleTimeoutMs must be a positive/);
  });
});
