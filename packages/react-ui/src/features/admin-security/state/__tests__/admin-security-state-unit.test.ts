import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontClient } from '@semiont/sdk';
import type { ShellStateUnit } from '../../../../state/shell-state-unit';
import { createAdminSecurityStateUnit } from '../admin-security-state-unit';

function mockBrowse(): ShellStateUnit {
  return { dispose: vi.fn() } as unknown as ShellStateUnit;
}

function mockClient(oauthConfig: ReturnType<typeof vi.fn>): SemiontClient {
  return { admin: { oauthConfig } } as unknown as SemiontClient;
}

describe('createAdminSecurityStateUnit', () => {
  it('fetches OAuth config on creation', async () => {
    const getOAuthConfig = vi.fn().mockResolvedValue({
      providers: [{ name: 'google' }],
      allowedDomains: ['example.com'],
    });
    const stateUnit = createAdminSecurityStateUnit(mockClient(getOAuthConfig), mockBrowse());

    const providers = await firstValueFrom(stateUnit.providers$.pipe(filter((p) => p.length > 0)));
    expect(providers).toEqual([{ name: 'google' }]);

    const domains = await firstValueFrom(stateUnit.allowedDomains$.pipe(filter((d) => d.length > 0)));
    expect(domains).toEqual(['example.com']);

    stateUnit.dispose();
  });

  it('starts loading, resolves to false', async () => {
    const stateUnit = createAdminSecurityStateUnit(
      mockClient(vi.fn().mockResolvedValue({ providers: [], allowedDomains: [] })),
      mockBrowse(),
    );

    await firstValueFrom(stateUnit.isLoading$.pipe(filter((l) => !l)));
    stateUnit.dispose();
  });

  it('sets loading false on error', async () => {
    const stateUnit = createAdminSecurityStateUnit(
      mockClient(vi.fn().mockRejectedValue(new Error('fail'))),
      mockBrowse(),
    );

    await firstValueFrom(stateUnit.isLoading$.pipe(filter((l) => !l)));
    stateUnit.dispose();
  });

  it('defaults to empty arrays when response has no providers/domains', async () => {
    const stateUnit = createAdminSecurityStateUnit(
      mockClient(vi.fn().mockResolvedValue({})),
      mockBrowse(),
    );

    await firstValueFrom(stateUnit.isLoading$.pipe(filter((l) => !l)));

    const providers = await firstValueFrom(stateUnit.providers$);
    const domains = await firstValueFrom(stateUnit.allowedDomains$);
    expect(providers).toEqual([]);
    expect(domains).toEqual([]);

    stateUnit.dispose();
  });
});
