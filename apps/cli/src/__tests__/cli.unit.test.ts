/**
 * The deprecated entry point does nothing but say so.
 *
 * `--version` and `--help` exit 0 (CI invokes them bare); anything else was a
 * real request that did not happen, so it exits 1.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { main } from '../cli.js';

describe('deprecated CLI entry point', () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { out.push(String(m)); });
    vi.spyOn(console, 'error').mockImplementation((m?: unknown) => { err.push(String(m)); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('--version exits 0 and marks itself deprecated', () => {
    expect(main(['--version'])).toBe(0);
    expect(out.join('\n')).toMatch(/deprecated/i);
  });

  it('--help exits 0 and points at the launcher', () => {
    expect(main(['--help'])).toBe(0);
    expect(out.join('\n')).toContain('brew install the-ai-alliance/semiont/semiont');
  });

  it('no arguments prints the notice and exits 0', () => {
    expect(main([])).toBe(0);
    expect(out.join('\n')).toMatch(/^Deprecated\./);
  });

  it('any former command fails loudly on stderr', () => {
    for (const verb of ['start', 'provision', 'useradd', 'backup', 'browse']) {
      err = [];
      expect(main([verb])).toBe(1);
      expect(err.join('\n')).toMatch(/^Deprecated\./);
      expect(err.join('\n')).toContain('brew install the-ai-alliance/semiont/semiont');
    }
  });
});
