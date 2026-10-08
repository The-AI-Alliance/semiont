/**
 * The worker's configuration document: where it is named, how it is read, and
 * what the worker refuses to start on.
 *
 * The document is `WorkerConfig` in specs/, resolved by whoever starts the
 * worker. These tests hold the reading side: the worker defaults nothing,
 * parses no TOML, and says which field or which variable it will not start
 * without.
 */
import { describe, it, expect } from 'vitest';
import { isObject } from '@semiont/core';
import { apiKeyOf, configPathOf, readWorkerConfig, serviceAccountOf } from '../worker-config';

const PATH = '/etc/semiont/worker.json';

const DOCUMENT = {
  gatewayUrl: 'http://gateway:4000',
  identity: { issuer: 'http://issuer:8080/realms/kb' },
  agents: [
    {
      agent: { provider: 'anthropic', model: 'claude-haiku-4-5' },
      accepts: [{ jobType: 'mark', params: { motivation: 'tagging' } }, { jobType: 'yield' }],
      baseUrl: 'https://api.anthropic.com',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
    },
    {
      agent: { provider: 'ollama', model: 'gemma3' },
      accepts: [{ jobType: 'mark', params: { motivation: 'highlighting' } }],
      baseUrl: 'http://ollama:11434',
    },
  ],
  port: 24100,
  logLevel: 'info',
  logFormat: 'json',
};

/** Where in the document: its members' names and its lists' positions, from the top. */
type Place = readonly (string | number)[];

function member(of: unknown, key: string | number): unknown {
  if (Array.isArray(of) && typeof key === 'number') return of[key];
  if (isObject(of) && typeof key === 'string') return of[key];
  throw new Error(`the document has no ${key} there`);
}

/** The document, as text, with what is at `place` taken out, or put there when a value is given. */
function documentWith(place: Place, ...put: [] | [unknown]): string {
  const document: unknown = structuredClone(DOCUMENT);
  const holder = place.slice(0, -1).reduce(member, document);
  const last = place[place.length - 1];
  if (Array.isArray(holder) && typeof last === 'number') {
    if (put.length === 1) holder[last] = put[0];
    else holder.splice(last, 1);
  } else if (isObject(holder) && typeof last === 'string') {
    if (put.length === 1) holder[last] = put[0];
    else delete holder[last];
  } else {
    throw new Error(`the document has nothing to change at ${place.join('.')}`);
  }
  return JSON.stringify(document);
}

const reading = (text: string) => () => readWorkerConfig(PATH, () => text);

describe('where the document is', () => {
  it('is the path after --config', () => {
    expect(configPathOf(['--config', PATH])).toBe(PATH);
  });

  it('is the path in --config=<path>', () => {
    expect(configPathOf([`--config=${PATH}`])).toBe(PATH);
  });

  it.each([
    ['no --config at all', []],
    ['--config with nothing after it', ['--config']],
    ['--config followed by another flag', ['--config', '--verbose']],
    ['--config= with nothing after it', ['--config=']],
  ])('is not guessed: %s refuses, saying how to name it', (_what, argv) => {
    expect(() => configPathOf(argv)).toThrow(
      'The worker\'s configuration document is not named: start it with --config <path>',
    );
  });
});

describe('reading the document', () => {
  it('gives the document as it was written', () => {
    expect(readWorkerConfig(PATH, () => JSON.stringify(DOCUMENT))).toEqual(DOCUMENT);
  });

  it('refuses a path that names no file, saying where it looked and who writes the document', () => {
    const absent = () => { throw new Error('ENOENT: no such file or directory'); };
    expect(() => readWorkerConfig(PATH, absent)).toThrow(
      `Cannot read the worker's configuration document at ${PATH} (ENOENT: no such file or directory). `
      + 'The launcher writes it; a worker started another way is given one (WorkerConfig in specs/).',
    );
  });

  it('refuses what is not JSON: a knowledge base\'s config is not the worker\'s document', () => {
    expect(reading('[environments.local.gateway]\npublicURL = "http://gateway"')).toThrow(`${PATH} is not JSON`);
  });

  it.each<[string, string, RegExp]>([
    ['the gateway', documentWith(['gatewayUrl']), /gatewayUrl/],
    ['the issuer', documentWith(['identity']), /identity/],
    ['every agent', documentWith(['agents'], []), /agents/],
    ['an agent\'s jobs', documentWith(['agents', 0, 'accepts'], []), /accepts/],
    ['an agent\'s provider address', documentWith(['agents', 1, 'baseUrl']), /baseUrl/],
    ['an agent\'s model', documentWith(['agents', 0, 'agent', 'model']), /model/],
    ['the health port', documentWith(['port']), /port/],
    ['the log level', documentWith(['logLevel']), /logLevel/],
  ])('refuses a document missing %s, naming the field', (_what, document, field) => {
    const refuses = reading(document);
    expect(refuses).toThrow(`${PATH} is not a worker configuration document (WorkerConfig):`);
    expect(refuses).toThrow(field);
  });

  it('refuses a secret\'s value where its name belongs, and does not repeat the value', () => {
    const refuses = reading(documentWith(['agents', 0, 'apiKey'], 'hunter2'));
    expect(refuses).toThrow(/apiKey/);
    expect(refuses).not.toThrow(/hunter2/);
  });

  it('refuses a job filter no claim could carry', () => {
    expect(reading(documentWith(['agents', 0, 'accepts', 0], { jobType: 'mark' }))).toThrow(
      `${PATH} is not a worker configuration document (WorkerConfig):`,
    );
  });
});

describe('what the document names and the environment holds', () => {
  const config = readWorkerConfig(PATH, () => JSON.stringify(DOCUMENT));

  it('an agent\'s key is the value of the variable the document names', () => {
    expect(apiKeyOf(config, 0, { ANTHROPIC_API_KEY: 'sk-test' })).toBe('sk-test');
  });

  it('an agent whose provider takes no key has none', () => {
    expect(apiKeyOf(config, 1, {})).toBeUndefined();
  });

  it.each([
    ['is not set', {}],
    ['is empty', { ANTHROPIC_API_KEY: '' }],
  ])('refuses to start when the variable an agent\'s key is named by %s, naming the field', (_how, env) => {
    expect(() => apiKeyOf(config, 0, env)).toThrow(
      new Error('agents[0].apiKeyEnv names a variable that is not set in the worker\'s environment'),
    );
  });

  // A document is read from a file anyone may have written: a key put where
  // its variable's name belongs is a value found in the document, and is not said.
  it('never repeats what the document gave as the variable\'s name', () => {
    const misplaced = readWorkerConfig(PATH, () => documentWith(['agents', 0, 'apiKeyEnv'], 'sk-ant-written-where-the-name-belongs'));
    let refusal = '';
    try {
      apiKeyOf(misplaced, 0, {});
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toBe('agents[0].apiKeyEnv names a variable that is not set in the worker\'s environment');
  });

  it('the service account is the two variables every service signs in with', () => {
    expect(serviceAccountOf(config, { SEMIONT_OIDC_CLIENT_ID: 'worker', SEMIONT_OIDC_CLIENT_SECRET: 's3cret' })).toEqual({
      issuer: 'http://issuer:8080/realms/kb',
      clientId: 'worker',
      clientSecret: 's3cret',
    });
  });

  it.each(['SEMIONT_OIDC_CLIENT_ID', 'SEMIONT_OIDC_CLIENT_SECRET'])(
    'refuses to start without its service account\'s %s, naming it',
    (missing) => {
      const env: Record<string, string> = { SEMIONT_OIDC_CLIENT_ID: 'worker', SEMIONT_OIDC_CLIENT_SECRET: 's3cret' };
      delete env[missing];
      expect(() => serviceAccountOf(config, env)).toThrow(missing);
    },
  );
});
