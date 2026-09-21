/**
 * The gateway refuses to boot when it cannot reach the record. Without these,
 * a structurally impossible config booted healthy and failed per request.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { requireArchivistAccess } from '../boot-requirements';

const withArchivist = {
  services: { archivist: { host: 'archivist.internal', port: 24103 } },
} as const;

describe('requireArchivistAccess', () => {
  const saved = { id: process.env.SEMIONT_OIDC_CLIENT_ID, secret: process.env.SEMIONT_OIDC_CLIENT_SECRET };

  beforeEach(() => {
    process.env.SEMIONT_OIDC_CLIENT_ID = 'semiont-gateway';
    process.env.SEMIONT_OIDC_CLIENT_SECRET = 'a-secret';
  });

  afterEach(() => {
    // Restore, not delete: other suites in this process read these.
    if (saved.id === undefined) delete process.env.SEMIONT_OIDC_CLIENT_ID;
    else process.env.SEMIONT_OIDC_CLIENT_ID = saved.id;
    if (saved.secret === undefined) delete process.env.SEMIONT_OIDC_CLIENT_SECRET;
    else process.env.SEMIONT_OIDC_CLIENT_SECRET = saved.secret;
  });

  it('accepts a config that names the record and a credential to reach it with', () => {
    expect(() => requireArchivistAccess(withArchivist)).not.toThrow();
  });

  it('refuses a config that names no Archivist, naming the key', () => {
    expect(() => requireArchivistAccess({ services: {} })).toThrow(/services\.archivist\.host/);
  });

  it('refuses an Archivist section with no host', () => {
    expect(() => requireArchivistAccess({ services: { archivist: {} } })).toThrow(
      /services\.archivist\.host/,
    );
  });

  it('refuses when the OIDC client id is unset, naming both variables', () => {
    delete process.env.SEMIONT_OIDC_CLIENT_ID;
    expect(() => requireArchivistAccess(withArchivist)).toThrow(/SEMIONT_OIDC_CLIENT_ID/);
  });

  it('refuses when the OIDC client secret is unset', () => {
    delete process.env.SEMIONT_OIDC_CLIENT_SECRET;
    expect(() => requireArchivistAccess(withArchivist)).toThrow(/SEMIONT_OIDC_CLIENT_SECRET/);
  });

  it('never prints the secret it read', () => {
    process.env.SEMIONT_OIDC_CLIENT_SECRET = 'super-secret-value';
    delete process.env.SEMIONT_OIDC_CLIENT_ID;
    expect(() => requireArchivistAccess(withArchivist)).toThrow();
    try {
      requireArchivistAccess(withArchivist);
    } catch (e) {
      expect((e as Error).message).not.toContain('super-secret-value');
    }
  });
});
