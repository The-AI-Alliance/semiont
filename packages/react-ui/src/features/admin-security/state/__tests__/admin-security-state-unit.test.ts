import { describe, it, expect, vi } from 'vitest';
import { sessionOf } from '../../../../__tests__/test-client';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontClient } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../../state/shell-state-unit';
import { createAdminSecurityStateUnit } from '../admin-security-state-unit';
import { assertStateUnitAxioms, disposeProbe } from '@semiont/core/testing/axioms';

const ISSUER = 'https://keycloak.example/realms/semiont';

function mockBrowse(): ShellStateUnit {
  return { dispose: vi.fn() } as unknown as ShellStateUnit;
}

function mockClient(oauthConfig: ReturnType<typeof vi.fn>): SemiontClient {
  return { admin: { oauthConfig } } as unknown as SemiontClient;
}

describe('createAdminSecurityStateUnit', () => {
  it('fetches the trusted issuer on creation', async () => {
    const getOAuthConfig = vi.fn().mockResolvedValue({
      issuer: ISSUER,
      audience: 'semiont-gateway',
    });
    const stateUnit = createAdminSecurityStateUnit(sessionOf(mockClient(getOAuthConfig)), mockBrowse());

    const issuer = await firstValueFrom(stateUnit.issuer$.pipe(filter((v) => v !== null)));
    expect(issuer).toBe(ISSUER);

    const audience = await firstValueFrom(stateUnit.audience$.pipe(filter((v) => v !== null)));
    expect(audience).toBe('semiont-gateway');

    stateUnit.dispose();
  });

  it('starts loading, resolves to false', async () => {
    const stateUnit = createAdminSecurityStateUnit(sessionOf(
      mockClient(vi.fn().mockResolvedValue({ issuer: ISSUER, audience: 'semiont-gateway' }))),
      mockBrowse(),
    );

    await firstValueFrom(stateUnit.isLoading$.pipe(filter((l) => !l)));
    stateUnit.dispose();
  });

  it('sets loading false on error', async () => {
    const stateUnit = createAdminSecurityStateUnit(sessionOf(
      mockClient(vi.fn().mockRejectedValue(new Error('fail')))),
      mockBrowse(),
    );

    await firstValueFrom(stateUnit.isLoading$.pipe(filter((l) => !l)));
    stateUnit.dispose();
  });

  it('stays null when the knowledge base trusts no issuer', async () => {
    const stateUnit = createAdminSecurityStateUnit(sessionOf(
      mockClient(vi.fn().mockResolvedValue({ issuer: null, audience: null }))),
      mockBrowse(),
    );

    await firstValueFrom(stateUnit.isLoading$.pipe(filter((l) => !l)));

    expect(await firstValueFrom(stateUnit.issuer$)).toBeNull();
    expect(await firstValueFrom(stateUnit.audience$)).toBeNull();

    stateUnit.dispose();
  });
});

describe('AdminSecurityStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms (incl. A7-passed: never disposes the injected browse)', () => {
    assertStateUnitAxioms({
      setup: () => {
        const browse = disposeProbe();
        const client = mockClient(vi.fn().mockResolvedValue({ issuer: null, audience: null }));
        return { unit: createAdminSecurityStateUnit(sessionOf(client), browse as unknown as ShellStateUnit), passedIn: [browse] };
      },
      surfaces: (u) => [u.issuer$, u.audience$, u.isLoading$],
    });
  });
});
