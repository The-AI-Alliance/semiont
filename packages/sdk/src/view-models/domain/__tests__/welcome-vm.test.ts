import { describe, it, expect, vi } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontClient } from '../../../client';
import { createWelcomeVM } from '../welcome-vm';

function mockClient(overrides: {
  getMe?: ReturnType<typeof vi.fn>;
  acceptTerms?: ReturnType<typeof vi.fn>;
} = {}): SemiontClient {
  return {
    getMe: overrides.getMe ?? vi.fn().mockResolvedValue({ termsAcceptedAt: undefined }),
    acceptTerms: overrides.acceptTerms ?? vi.fn().mockResolvedValue(undefined),
  } as unknown as SemiontClient;
}

describe('createWelcomeVM', () => {
  it('fetches user data on creation', async () => {
    const getMe = vi.fn().mockResolvedValue({ termsAcceptedAt: '2026-01-01' });
    const vm = createWelcomeVM(mockClient({ getMe }));

    const data = await firstValueFrom(vm.userData$.pipe(filter((d) => d !== null)));
    expect(data).toEqual({ termsAcceptedAt: '2026-01-01' });

    vm.dispose();
  });

  it('initializes with null userData and not processing', async () => {
    const getMe = vi.fn().mockReturnValue(new Promise(() => {}));
    const vm = createWelcomeVM(mockClient({ getMe }));

    const data = await firstValueFrom(vm.userData$);
    const processing = await firstValueFrom(vm.isProcessing$);
    expect(data).toBeNull();
    expect(processing).toBe(false);

    vm.dispose();
  });

  it('acceptTerms sets isProcessing and updates userData', async () => {
    const acceptTerms = vi.fn().mockResolvedValue(undefined);
    const vm = createWelcomeVM(mockClient({ acceptTerms }));

    await firstValueFrom(vm.userData$.pipe(filter((d) => d !== null)));

    await vm.acceptTerms();

    expect(acceptTerms).toHaveBeenCalledOnce();

    const data = await firstValueFrom(vm.userData$);
    expect(data?.termsAcceptedAt).toBeDefined();

    const processing = await firstValueFrom(vm.isProcessing$);
    expect(processing).toBe(false);

    vm.dispose();
  });

  it('acceptTerms resets isProcessing on error', async () => {
    const acceptTerms = vi.fn().mockRejectedValue(new Error('fail'));
    const vm = createWelcomeVM(mockClient({ acceptTerms }));

    await firstValueFrom(vm.userData$.pipe(filter((d) => d !== null)));

    await expect(vm.acceptTerms()).rejects.toThrow('fail');

    const processing = await firstValueFrom(vm.isProcessing$);
    expect(processing).toBe(false);

    vm.dispose();
  });

  it('handles getMe failure gracefully', async () => {
    const getMe = vi.fn().mockRejectedValue(new Error('unauthorized'));
    const vm = createWelcomeVM(mockClient({ getMe }));

    await vi.waitFor(() => expect(getMe).toHaveBeenCalled());

    const data = await firstValueFrom(vm.userData$);
    expect(data).toBeNull();

    vm.dispose();
  });
});
