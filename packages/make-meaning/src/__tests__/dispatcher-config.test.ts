import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { configPathFrom, readDispatcherConfig, namedSecret, type DispatcherConfig } from '../dispatcher-config.js';

const valid: DispatcherConfig = {
  gatewayUrl: 'http://gateway:4000',
  identity: { issuer: 'http://keycloak:8080/realms/semiont' },
  queue: { servers: 'nats:4222', userEnv: 'NATS_USER', passwordEnv: 'NATS_PASSWORD' },
  port: 24105,
  timing: {
    tickMs: 30_000,
    staleRunningMs: 1_800_000,
    ackWaitMs: 30_000,
    retentionMs: 86_400_000,
    retentionSweepMs: 3_600_000,
    progressWriteIntervalMs: 5_000,
    bootDeadlineMs: 60_000,
  },
  logLevel: 'info',
  logFormat: 'json',
};

describe('configPathFrom', () => {
  test('reads --config <path> and --config=<path>', () => {
    expect(configPathFrom(['node', 'main.js', '--config', '/etc/semiont/dispatcher.json'])).toBe('/etc/semiont/dispatcher.json');
    expect(configPathFrom(['node', 'main.js', '--config=/tmp/d.json'])).toBe('/tmp/d.json');
  });

  test('refuses to start with no document named', () => {
    for (const argv of [['node', 'main.js'], ['node', 'main.js', '--config'], ['node', 'main.js', '--config', '--other'], ['node', 'main.js', '--config=']]) {
      expect(() => configPathFrom(argv)).toThrow(/--config <path>/);
    }
  });
});

describe('readDispatcherConfig', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dispatcher-config-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const write = (content: string) => {
    const path = join(dir, 'dispatcher.json');
    writeFileSync(path, content);
    return path;
  };

  test('returns a valid document as written', () => {
    expect(readDispatcherConfig(write(JSON.stringify(valid)))).toEqual(valid);
  });

  test('refuses a path that names no file', () => {
    expect(() => readDispatcherConfig(join(dir, 'absent.json'))).toThrow(/Cannot read the dispatcher's configuration document at .*absent\.json/);
  });

  test('refuses a document that is not JSON', () => {
    expect(() => readDispatcherConfig(write('gatewayUrl = "x"'))).toThrow(/is not JSON/);
  });

  test('refuses an invalid document, naming the field', () => {
    const { tickMs: _tickMs, ...timing } = valid.timing;
    expect(() => readDispatcherConfig(write(JSON.stringify({ ...valid, timing })))).toThrow(/is not valid: .*tickMs/);
    expect(() => readDispatcherConfig(write(JSON.stringify({ ...valid, queue: { ...valid.queue, password: 'hunter2' } })))).toThrow(/is not valid/);
  });
});

describe('namedSecret', () => {
  const NAME = 'DISPATCHER_CONFIG_TEST_SECRET';
  afterEach(() => { delete process.env[NAME]; });

  test('reads the variable a field names', () => {
    process.env[NAME] = 'the-value';
    expect(namedSecret('queue.passwordEnv', NAME)).toBe('the-value');
  });

  test('names nothing when the field is absent', () => {
    expect(namedSecret('queue.passwordEnv', undefined)).toBeUndefined();
  });

  test('refuses a named variable that is unset, naming the field and the variable', () => {
    expect(() => namedSecret('queue.passwordEnv', NAME)).toThrow(new RegExp(`names ${NAME} for queue\\.passwordEnv`));
  });
});
