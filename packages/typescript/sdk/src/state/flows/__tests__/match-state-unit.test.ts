import { describe, it, vi } from 'vitest';
import { createMatchStateUnit, type MatchStateUnit } from '../match-state-unit';
import { makeTestClient, type TestClient } from '../../../__tests__/test-client';
import { assertStateUnitAxioms } from '@semiont/core/testing/axioms';

function withMatch(searchFn: ReturnType<typeof vi.fn>): TestClient {
  return makeTestClient({ match: { search: searchFn } });
}

describe('MatchStateUnit — StateUnit axioms', () => {
  it('satisfies the StateUnit axioms', () => {
    assertStateUnitAxioms<MatchStateUnit>({
      setup: () => {
        const tc = withMatch(vi.fn());
        return { unit: createMatchStateUnit(tc.client), teardown: () => tc.bus.destroy() };
      },
    });
  });
});
