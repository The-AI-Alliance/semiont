import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getStoredSession, setStoredSession } from '@semiont/sdk';
import { FileSessionStorage } from './session-file';

const freshPath = () => join(mkdtempSync(join(tmpdir(), 'chat-sessions-')), 'nested', 'kb.json');

describe('FileSessionStorage', () => {
  it('keeps what is set across a reopen', () => {
    const path = freshPath();
    new FileSessionStorage(path).set('a', 'one');
    const reopened = new FileSessionStorage(path);
    expect(reopened.get('a')).toBe('one');
    expect(reopened.get('never-set')).toBeNull();
  });

  it('writes a file only its owner can read', () => {
    const path = freshPath();
    new FileSessionStorage(path).set('a', 'one');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('forgets a deleted key, and remove() takes the file with it', () => {
    const path = freshPath();
    const storage = new FileSessionStorage(path);
    storage.set('a', 'one');
    storage.set('b', 'two');
    storage.delete('a');
    const reopened = new FileSessionStorage(path);
    expect(reopened.get('a')).toBeNull();
    expect(reopened.get('b')).toBe('two');

    storage.remove();
    expect(existsSync(path)).toBe(false);
    expect(storage.get('b')).toBeNull();
  });

  it('holds a stored session as the SDK writes one, for the SDK to read back', () => {
    const path = freshPath();
    const session = {
      access: 'access-token',
      refresh: 'refresh-token',
      clientId: 'semiont-browser',
      tokenEndpoint: 'http://issuer.example/token',
      revocationEndpoint: 'http://issuer.example/revoke',
    };
    setStoredSession(new FileSessionStorage(path), 'localhost:4000', session);
    expect(getStoredSession(new FileSessionStorage(path), 'localhost:4000')).toEqual(session);
  });

  it('refuses to open a file that is not one of its own', () => {
    const notJson = freshPath();
    new FileSessionStorage(notJson).set('a', 'one');
    writeFileSync(notJson, 'not json');
    expect(() => new FileSessionStorage(notJson)).toThrow(`${notJson} is not a session file`);

    const wrongShape = freshPath();
    new FileSessionStorage(wrongShape).set('a', 'one');
    writeFileSync(wrongShape, JSON.stringify({ a: { nested: true } }));
    expect(() => new FileSessionStorage(wrongShape)).toThrow(/not a session file/);
  });
});
