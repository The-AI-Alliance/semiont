import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontClient } from '../../../client';
import type { ShellVM } from '../../flows/shell-vm';
import { createAdminSecurityVM } from '../admin-security-vm';

function mockBrowse(): ShellVM {
  return { dispose: vi.fn() } as unknown as ShellVM;
}

function mockClient(oauthConfig: ReturnType<typeof vi.fn>): SemiontClient {
  return { admin: { oauthConfig } } as unknown as SemiontClient;
}

describe('createAdminSecurityVM', () => {
  it('fetches OAuth config on creation', async () => {
    const getOAuthConfig = vi.fn().mockResolvedValue({
      providers: [{ name: 'google' }],
      allowedDomains: ['example.com'],
    });
    const vm = createAdminSecurityVM(mockClient(getOAuthConfig), mockBrowse());

    const providers = await firstValueFrom(vm.providers$.pipe(filter((p) => p.length > 0)));
    expect(providers).toEqual([{ name: 'google' }]);

    const domains = await firstValueFrom(vm.allowedDomains$.pipe(filter((d) => d.length > 0)));
    expect(domains).toEqual(['example.com']);

    vm.dispose();
  });

  it('starts loading, resolves to false', async () => {
    const vm = createAdminSecurityVM(
      mockClient(vi.fn().mockResolvedValue({ providers: [], allowedDomains: [] })),
      mockBrowse(),
    );

    await firstValueFrom(vm.isLoading$.pipe(filter((l) => !l)));
    vm.dispose();
  });

  it('sets loading false on error', async () => {
    const vm = createAdminSecurityVM(
      mockClient(vi.fn().mockRejectedValue(new Error('fail'))),
      mockBrowse(),
    );

    await firstValueFrom(vm.isLoading$.pipe(filter((l) => !l)));
    vm.dispose();
  });

  it('defaults to empty arrays when response has no providers/domains', async () => {
    const vm = createAdminSecurityVM(
      mockClient(vi.fn().mockResolvedValue({})),
      mockBrowse(),
    );

    await firstValueFrom(vm.isLoading$.pipe(filter((l) => !l)));

    const providers = await firstValueFrom(vm.providers$);
    const domains = await firstValueFrom(vm.allowedDomains$);
    expect(providers).toEqual([]);
    expect(domains).toEqual([]);

    vm.dispose();
  });
});
