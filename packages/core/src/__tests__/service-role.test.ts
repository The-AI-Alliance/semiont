/**
 * The service-account role, and the predicate that reads it off a token.
 *
 * These live in CORE because the value and the shape check are core's: the
 * gateway gates `POST /api/tokens/agent` on them and the Archivist gates its
 * read path, and both used to implement the check themselves. They had already
 * drifted — one guarded against non-string array members, the other did not.
 *
 * Imported from SOURCE, not from `@semiont/core`: a suite that tests its own
 * package through the built artifact reports on the last build, not on the
 * working tree.
 */
import { describe, it, expect } from 'vitest';
import { SERVICE_ROLE, ROLES_CLAIM, hasServiceRole } from '../service-role';

describe('the service role', () => {
  it('is carried in a FLAT `roles` claim', () => {
    // Both halves are wire vocabulary a realm stamps, so both are pinned.
    expect(ROLES_CLAIM).toBe('roles');
    expect(SERVICE_ROLE).toBe('semiont-service');
  });
});

describe('hasServiceRole', () => {
  it('admits a flat array carrying the role', () => {
    expect(hasServiceRole({ roles: [SERVICE_ROLE] })).toBe(true);
  });

  it('admits it alongside other roles', () => {
    expect(hasServiceRole({ roles: ['offline_access', SERVICE_ROLE, 'uma_authorization'] })).toBe(true);
  });

  it('REFUSES Keycloak\'s nested realm_access.roles shape', () => {
    // The failure this predicate exists to make loud. A client configured by
    // hand produces exactly this, the console shows the role present, and
    // every service-to-service call is refused with nothing naming the cause.
    expect(hasServiceRole({ realm_access: { roles: [SERVICE_ROLE] } })).toBe(false);
  });

  it('refuses a token carrying no roles claim at all', () => {
    expect(hasServiceRole({})).toBe(false);
    expect(hasServiceRole({ sub: 'someone', aud: 'semiont-gateway' })).toBe(false);
  });

  it('refuses a roles claim that is not an array', () => {
    // A single-valued mapper is a realistic misconfiguration, and a substring
    // check on a string would have admitted "not-semiont-service".
    expect(hasServiceRole({ roles: SERVICE_ROLE })).toBe(false);
    expect(hasServiceRole({ roles: { [SERVICE_ROLE]: true } })).toBe(false);
    expect(hasServiceRole({ roles: null })).toBe(false);
  });

  it('refuses an array whose members are not strings', () => {
    // The half of the check the two readers disagreed about before this moved
    // into core: `[{ name: 'semiont-service' }]` is not the role.
    expect(hasServiceRole({ roles: [{ name: SERVICE_ROLE }] })).toBe(false);
    expect(hasServiceRole({ roles: [null, undefined] })).toBe(false);
  });

  it('refuses a role that merely contains the right substring', () => {
    expect(hasServiceRole({ roles: ['not-semiont-service'] })).toBe(false);
    expect(hasServiceRole({ roles: ['semiont-service-admin'] })).toBe(false);
  });

  it('refuses an empty array', () => {
    expect(hasServiceRole({ roles: [] })).toBe(false);
  });
});
