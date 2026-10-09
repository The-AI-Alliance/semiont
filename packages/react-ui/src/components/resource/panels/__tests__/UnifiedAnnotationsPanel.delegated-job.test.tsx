/**
 * The delegated job's id goes where its progress goes: to the panel of the
 * delegated motivation, whose cancel control names that job.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderInEnglish } from '../../../../test-utils';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { LinkComponentProps, RouteBuilder } from '../../../../contexts/RoutingContext';
import { UnifiedAnnotationsPanel } from '../UnifiedAnnotationsPanel';
import { ANNOTATORS } from '../../../../lib/annotation-registry';
import { jobId, resourceId } from '@semiont/core';

const TestLink = ({ href, children, ...rest }: LinkComponentProps) => <a href={href} {...rest}>{children}</a>;
const testRoutes: RouteBuilder = { resourceDetail: (id) => `/r/${id}` };

function fakeSession(cancel: ReturnType<typeof vi.fn>): SemiontSession {
  return {
    client: { browse: { click: vi.fn() }, beckon: { hover: vi.fn() }, job: { cancel } },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

type PanelProps = React.ComponentProps<typeof UnifiedAnnotationsPanel>;

const delegating = (cancel: ReturnType<typeof vi.fn>, motivation: PanelProps['delegatingMotivation']): PanelProps => ({
  session: fakeSession(cancel),
  annotations: [],
  annotators: ANNOTATORS,
  annotateMode: true,
  allEntityTypes: [],
  pendingAnnotation: null,
  delegatingMotivation: motivation,
  progress: { percentage: 10 },
  jobId: jobId('job-1'),
  resourceId: resourceId('res-1'),
  initialTab: 'reference',
  Link: TestLink,
  routes: testRoutes,
});

describe('UnifiedAnnotationsPanel: the delegated job', () => {
  it("gives a linking job's id to the references panel, whose control cancels that job", () => {
    const cancel = vi.fn().mockResolvedValue(true);
    renderInEnglish(<UnifiedAnnotationsPanel {...delegating(cancel, 'linking')} />);

    fireEvent.click(screen.getByTestId('semiont-delegate-control'));
    expect(cancel).toHaveBeenCalledExactlyOnceWith('job-1');
  });

  it("shows the references panel no control for another motivation's job", () => {
    const cancel = vi.fn().mockResolvedValue(true);
    renderInEnglish(<UnifiedAnnotationsPanel {...delegating(cancel, 'highlighting')} />);

    expect(screen.queryByTestId('semiont-delegate-control')).toBeNull();
  });
});
