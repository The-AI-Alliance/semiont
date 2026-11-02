import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setStoredSession } from '@semiont/sdk';
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
    expect(new FileSessionStorage(path).values()).toEqual(['two']);

    storage.remove();
    expect(existsSync(path)).toBe(false);
    expect(storage.values()).toEqual([]);
  });

  it('holds a stored session as the SDK writes one', () => {
    const path = freshPath();
    setStoredSession(new FileSessionStorage(path), 'localhost:4000', {
      access: 'access-token',
      refresh: 'refresh-token',
      clientId: 'semiont-browser',
      tokenEndpoint: 'http://issuer.example/token',
    });
    const [stored] = new FileSessionStorage(path).values();
    expect(JSON.parse(stored ?? '')).toEqual(expect.objectContaining({ refresh: 'refresh-token' }));
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
