import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { SemiontSession } from '@semiont/sdk';
import { AuthNamespace } from '@semiont/sdk';
import { createTestSession, stubGateway } from '@semiont/sdk/testing';
import { createWelcomeStateUnit } from '../welcome-state-unit';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';

// Real session over the scriptable transport (SESSION-TYPED-FACTORIES pilot);
// auth behavior scripted by prototype spies, the AuthShell precedent — the
// previous `as unknown as SemiontClient` hand-mock was the M1 disease.
let getMe: ReturnType<typeof vi.spyOn>;
let acceptTermsSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  getMe = vi.spyOn(AuthNamespace.prototype, 'me');
  getMe.mockResolvedValue({ termsAcceptedAt: undefined } as never);
  acceptTermsSpy = vi.spyOn(AuthNamespace.prototype, 'acceptTerms');
  acceptTermsSpy.mockResolvedValue(undefined as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeSession(): SemiontSession {
  return createTestSession({ gateway: stubGateway() }).session;
}

describe('createWelcomeStateUnit', () => {
  it('fetches user data on creation', async () => {
    getMe.mockResolvedValue({ termsAcceptedAt: '2026-01-01' } as never);
    const stateUnit = createWelcomeStateUnit(makeSession());

    const data = await firstValueFrom(stateUnit.userData$.pipe(filter((d) => d !== null)));
    expect(data).toEqual({ termsAcceptedAt: '2026-01-01' });

    stateUnit.dispose();
  });

  it('initializes with null userData and not processing', async () => {
    getMe.mockReturnValue(new Promise(() => {}) as never);
    const stateUnit = createWelcomeStateUnit(makeSession());

    const data = await firstValueFrom(stateUnit.userData$);
    const processing = await firstValueFrom(stateUnit.isProcessing$);
    expect(data).toBeNull();
    expect(processing).toBe(false);

    stateUnit.dispose();
  });

  it('acceptTerms sets isProcessing and updates userData', async () => {
    const stateUnit = createWelcomeStateUnit(makeSession());

    await firstValueFrom(stateUnit.userData$.pipe(filter((d) => d !== null)));

    await stateUnit.acceptTerms();

    expect(acceptTermsSpy).toHaveBeenCalledOnce();

    const data = await firstValueFrom(stateUnit.userData$);
    expect(data?.termsAcceptedAt).toBeDefined();

    const processing = await firstValueFrom(stateUnit.isProcessing$);
    expect(processing).toBe(false);

    stateUnit.dispose();
  });

  it('acceptTerms resets isProcessing on error', async () => {
    acceptTermsSpy.mockRejectedValue(new Error('fail') as never);
    const stateUnit = createWelcomeStateUnit(makeSession());

    await firstValueFrom(stateUnit.userData$.pipe(filter((d) => d !== null)));

    await expect(stateUnit.acceptTerms()).rejects.toThrow('fail');

    const processing = await firstValueFrom(stateUnit.isProcessing$);
    expect(processing).toBe(false);

    stateUnit.dispose();
  });

  it('handles getMe failure gracefully', async () => {
    getMe.mockRejectedValue(new Error('unauthorized') as never);
    const stateUnit = createWelcomeStateUnit(makeSession());

    await vi.waitFor(() => expect(getMe).toHaveBeenCalled());

    const data = await firstValueFrom(stateUnit.userData$);
    expect(data).toBeNull();

    stateUnit.dispose();
  });
});

describe('WelcomeStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    assertStateUnitAxioms({
      setup: () => createWelcomeStateUnit(makeSession()),
      surfaces: (u) => [u.userData$, u.isProcessing$],
      invocations: (u) => [() => u.acceptTerms()],
    });
  });
});
