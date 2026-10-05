import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configPathFrom, readArchivistConfig, type ArchivistConfig } from '../archivist/archivist-config';

const valid: ArchivistConfig = {
  gatewayUrl: 'http://gateway:4000',
  identity: { issuer: 'http://keycloak:8080/realms/semiont' },
  root: '/kb',
  anchoredTextDir: '/anchored-text',
  roster: {
    workers: { generation: { provider: 'anthropic', model: 'claude-haiku-4-5' } },
    actors: { matcher: { provider: 'ollama', model: 'gemma2:27b' } },
  },
  port: 24103,
  skipRebuild: false,
  staging: { flushMs: 250, maxWaitMs: 2_000 },
  logLevel: 'info',
  logFormat: 'json',
};

describe('configPathFrom', () => {
  test('reads --config <path> and --config=<path>', () => {
    expect(configPathFrom(['--config', '/etc/semiont/archivist.json'])).toBe('/etc/semiont/archivist.json');
    expect(configPathFrom(['--config=/tmp/a.json'])).toBe('/tmp/a.json');
  });

  test('refuses to start with no document named', () => {
    for (const argv of [[], ['--config'], ['--config', '--other'], ['--config=']]) {
      expect(() => configPathFrom(argv)).toThrow(/--config <path>/);
    }
  });
});

describe('readArchivistConfig', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'archivist-config-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const write = (document: unknown) => {
    const path = join(dir, 'archivist.json');
    writeFileSync(path, typeof document === 'string' ? document : JSON.stringify(document));
    return path;
  };

  test('returns a valid document as written', () => {
    expect(readArchivistConfig(write(valid))).toEqual(valid);
  });

  test('refuses a path that names no file', () => {
    expect(() => readArchivistConfig(join(dir, 'absent.json'))).toThrow(/Cannot read the Archivist's configuration document at .*absent\.json/);
  });

  test('refuses a document that is not JSON', () => {
    expect(() => readArchivistConfig(write('gatewayUrl = "x"'))).toThrow(/is not JSON/);
  });

  test('refuses a document missing a field, naming it', () => {
    const { maxWaitMs: _maxWaitMs, ...staging } = valid.staging;
    expect(() => readArchivistConfig(write({ ...valid, staging }))).toThrow(/is not valid: .*maxWaitMs/);
    const { skipRebuild: _skipRebuild, ...rest } = valid;
    expect(() => readArchivistConfig(write(rest))).toThrow(/is not valid: .*skipRebuild/);
  });

  test('refuses a role that carries a credential, a role it does not know, and a provider it does not know', () => {
    const withRole = (workers: unknown) => write({ ...valid, roster: { ...valid.roster, workers } });
    expect(() => readArchivistConfig(withRole({ generation: { provider: 'anthropic', model: 'm', apiKey: 'k' } }))).toThrow(/is not valid/);
    expect(() => readArchivistConfig(withRole({ default: { provider: 'anthropic', model: 'm' } }))).toThrow(/is not valid/);
    expect(() => readArchivistConfig(withRole({ generation: { provider: 'openai', model: 'm' } }))).toThrow(/is not valid/);
  });
});
