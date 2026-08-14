/**
 * The viewer's arrival report — GUIDED-TOUR P5 (D6).
 *
 * `browse:resource-viewed` is a REPORT, deliberately distinct from the
 * imperative `browse:resource-open`: it fires when a resource has actually
 * loaded on screen, however the user got there (followed cue, in-app link,
 * back button, typed URL). The contract this pins: once per arrival — never
 * on unrelated re-renders, never before the content is up, and again when
 * the viewer moves to a different resource.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useResourceViewedReport } from '../useResourceViewedReport';
import { createTestSemiontWrapper } from '../../../../test-utils';
import { resourceId } from '@semiont/core';

function makeWrapper() {
  const { SemiontWrapper, client } = createTestSemiontWrapper();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SemiontWrapper>{children}</SemiontWrapper>
  );
  const viewed = vi.spyOn(client.browse, 'resourceViewed').mockImplementation(() => {});
  return { wrapper, viewed };
}

const RID_A = resourceId('resaaa11223344556677889900aabbcc');
const RID_B = resourceId('resbbb11223344556677889900aabbcc');

describe('useResourceViewedReport', () => {
  it('reports once when the resource finishes loading, not before and not again on re-render', () => {
    const { wrapper, viewed } = makeWrapper();

    const { rerender } = renderHook(
      ({ rid, loaded }: { rid: ReturnType<typeof resourceId>; loaded: boolean }) => useResourceViewedReport(rid, loaded),
      { wrapper, initialProps: { rid: RID_A, loaded: false } },
    );
    expect(viewed).not.toHaveBeenCalled();

    rerender({ rid: RID_A, loaded: true });
    expect(viewed).toHaveBeenCalledTimes(1);

    rerender({ rid: RID_A, loaded: true });
    rerender({ rid: RID_A, loaded: true });
    expect(viewed).toHaveBeenCalledTimes(1);
  });

  it('reports again when the viewer arrives at a different resource', () => {
    const { wrapper, viewed } = makeWrapper();

    const { rerender } = renderHook(
      ({ rid, loaded }: { rid: ReturnType<typeof resourceId>; loaded: boolean }) => useResourceViewedReport(rid, loaded),
      { wrapper, initialProps: { rid: RID_A, loaded: true } },
    );
    expect(viewed).toHaveBeenCalledTimes(1);

    rerender({ rid: RID_B, loaded: false });
    expect(viewed).toHaveBeenCalledTimes(1);

    rerender({ rid: RID_B, loaded: true });
    expect(viewed).toHaveBeenCalledTimes(2);
  });
});
