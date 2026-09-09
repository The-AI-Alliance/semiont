/**
 * RD4's completeness badge finds its home here (DETECTION-RESULT-STREAMING
 * P3): the panel that already fans assist state out per motivation tab. The
 * badge renders only for a SETTLED outcome, only on the tab whose motivation
 * the run belonged to — and never invents a third state: no outcome means no
 * badge, not "unknown".
 *
 * The incomplete-with-standing-annotations row is pinned at the decision
 * function (assist-completeness.test.ts); what this file pins is the WIRE —
 * that the panel actually consults the outcome and keys it to the right tab.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { RouteBuilder } from '../../../../contexts/RoutingContext';
import { UnifiedAnnotationsPanel } from '../UnifiedAnnotationsPanel';
import { ANNOTATORS } from '../../../../lib/annotation-registry';

const TestLink = ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a>;
const testRoutes = {
  resourceDetail: (id: string) => `/r/${id}`,
} as unknown as RouteBuilder;

function fakeSession(): SemiontSession {
  return {
    client: { browse: { click: vi.fn() }, beckon: { hover: vi.fn() } },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

type PanelProps = React.ComponentProps<typeof UnifiedAnnotationsPanel>;

const base = (): PanelProps => ({
  session: fakeSession(),
  annotations: [],
  annotators: ANNOTATORS,
  allEntityTypes: [],
  pendingAnnotation: null,
  resourceId: 'res-1',
  Link: TestLink,
  routes: testRoutes,
});

const badge = () => screen.queryByRole('status');

describe('UnifiedAnnotationsPanel — RD4 completeness badge', () => {
  it('a settled clean run badges its own tab as complete', () => {
    render(
      <UnifiedAnnotationsPanel
        {...base()}
        assistOutcome={{ kind: 'complete', motivation: 'highlighting' }}
      />,
    );
    fireEvent.click(screen.getByTitle('Highlights'));

    expect(badge()).toHaveAttribute('data-verdict', 'clean');
  });

  it('a settled under-reported run badges partial', () => {
    render(
      <UnifiedAnnotationsPanel
        {...base()}
        assistOutcome={{ kind: 'complete', motivation: 'highlighting', underReportedPieces: 2 }}
      />,
    );
    fireEvent.click(screen.getByTitle('Highlights'));

    expect(badge()).toHaveAttribute('data-verdict', 'under-reported');
  });

  it("the badge stays off tabs the run did not belong to", () => {
    render(
      <UnifiedAnnotationsPanel
        {...base()}
        assistOutcome={{ kind: 'complete', motivation: 'highlighting', underReportedPieces: 2 }}
      />,
    );
    fireEvent.click(screen.getByTitle('Comments'));

    expect(badge()).not.toBeInTheDocument();
  });

  it('a terminal fail with nothing standing badges nothing — that failure is toasted, not badged', () => {
    render(
      <UnifiedAnnotationsPanel
        {...base()}
        assistOutcome={{ kind: 'incomplete', motivation: 'highlighting' }}
      />,
    );
    fireEvent.click(screen.getByTitle('Highlights'));

    expect(badge()).not.toBeInTheDocument();
  });

  it('no settled outcome, no badge — mid-run absence is not cleanliness', () => {
    render(<UnifiedAnnotationsPanel {...base()} />);
    fireEvent.click(screen.getByTitle('Highlights'));

    expect(badge()).not.toBeInTheDocument();
  });
});
