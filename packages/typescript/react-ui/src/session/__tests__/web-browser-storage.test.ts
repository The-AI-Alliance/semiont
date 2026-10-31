/**
 * WebBrowserStorage — text under a key in the page's `localStorage`, and
 * what another window writes there, heard through the `storage` event.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WebBrowserStorage } from '../web-browser-storage';

beforeEach(() => {
  localStorage.clear();
});

describe('WebBrowserStorage', () => {
  it('changes a value as one step: the change is given what localStorage holds and says what it holds next', () => {
    const storage = new WebBrowserStorage();
    localStorage.setItem('k', 'before');
    const given: Array<string | null> = [];

    storage.update('k', (stored) => {
      given.push(stored);
      return `${stored}-after`;
    });

    expect(given).toEqual(['before']);
    expect(localStorage.getItem('k')).toBe('before-after');
  });

  it('gives a change null when nothing is stored, and removes the key when the change says null', () => {
    const storage = new WebBrowserStorage();
    const given: Array<string | null> = [];

    storage.update('k', (stored) => {
      given.push(stored);
      return 'written';
    });
    expect(localStorage.getItem('k')).toBe('written');
    storage.update('k', () => null);

    expect(given).toEqual([null]);
    expect(localStorage.getItem('k')).toBeNull();
  });

  it('hears what another window writes, until the subscription ends', () => {
    const storage = new WebBrowserStorage();
    const heard: Array<[string, string | null]> = [];

    const stop = storage.subscribe((key, value) => heard.push([key, value]));
    window.dispatchEvent(new StorageEvent('storage', { key: 'k', newValue: 'from-there' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'k', newValue: null }));
    stop();
    window.dispatchEvent(new StorageEvent('storage', { key: 'k', newValue: 'unheard' }));

    expect(heard).toEqual([['k', 'from-there'], ['k', null]]);
  });
});
