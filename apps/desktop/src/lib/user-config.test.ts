import { describe, it, expect } from 'vitest';
import {
  parseUserConfig,
  serializeUserConfig,
  kbTargetFor,
  parseKbUri,
  EMPTY_USER_CONFIG,
  type UserConfig,
} from './user-config';

const FULL: UserConfig = {
  kbs: [
    { uri: 'http://localhost:4000' },
    { uri: 'https://kb.example.com', alias: 'Prod' },
  ],
};

describe('user-config round-trip', () => {
  it('serialize → parse preserves the config', () => {
    expect(parseUserConfig(serializeUserConfig(FULL))).toEqual(FULL);
  });

  it('empty/malformed input → empty config', () => {
    expect(parseUserConfig('')).toEqual(EMPTY_USER_CONFIG);
    expect(parseUserConfig('not = valid = toml =')).toEqual(EMPTY_USER_CONFIG);
  });

  it('drops a KB entry with no uri', () => {
    expect(parseUserConfig('[[kb]]\nalias = "x"').kbs).toEqual([]);
  });

  it('reads an entry written before sign-in moved to the issuer, without its credentials', () => {
    const old = '[[kb]]\nuri = "http://localhost:4000"\nemail = "a@b.com"\npassword = "pw"\nalias = "Local"';
    const config = parseUserConfig(old);
    expect(config).toEqual({ kbs: [{ uri: 'http://localhost:4000', alias: 'Local' }] });
    expect(serializeUserConfig(config)).not.toMatch(/email|password/);
  });
});

describe('kbTargetFor', () => {
  it('names the session by the address, and labels it by the host when there is no alias', () => {
    expect(kbTargetFor({ uri: 'http://localhost:4000' })).toEqual({
      id: 'localhost:4000',
      label: 'localhost',
      endpoint: { kind: 'http', host: 'localhost', port: 4000, protocol: 'http' },
    });
  });

  it('labels it by the alias when there is one', () => {
    expect(kbTargetFor({ uri: 'https://kb.example.com', alias: 'Prod' })).toEqual({
      id: 'kb.example.com:443',
      label: 'Prod',
      endpoint: { kind: 'http', host: 'kb.example.com', port: 443, protocol: 'https' },
    });
  });

  it('returns null for a malformed KB uri', () => {
    expect(kbTargetFor({ uri: 'nope' })).toBeNull();
  });
});

describe('parseKbUri', () => {
  it('splits host/port/protocol; defaults the port from the scheme', () => {
    expect(parseKbUri('http://localhost:4000')).toEqual({ host: 'localhost', port: 4000, protocol: 'http' });
    expect(parseKbUri('https://kb.example.com')).toEqual({ host: 'kb.example.com', port: 443, protocol: 'https' });
  });

  it('rejects non-http and invalid urls', () => {
    expect(() => parseKbUri('ftp://h')).toThrow(/http or https/);
    expect(() => parseKbUri('nope')).toThrow(/valid URL/);
  });
});
