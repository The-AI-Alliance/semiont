/**
 * The annotations panel must be able to say the annotations failed to load.
 *
 * Every tab in this panel derives from one `annotations` array. When that load
 * fails terminally (B15) the array is empty — indistinguishable from a
 * resource that genuinely has no annotations, so the panel cheerfully reports
 * "no highlights" for a resource full of them. That is the same
 * apparent-data-loss shape as the PDF-annotations bug, arrived at from a
 * different direction.
 *
 * See .plans/PANEL-FAILURE-STATES.md
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
import { resourceId } from '@semiont/core';

const TestLink = ({ href, children, ...rest }: LinkComponentProps) => <a href={href} {...rest}>{children}</a>;
const testRoutes: RouteBuilder = { resourceDetail: (id) => `/r/${id}` };

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
  resourceId: resourceId('res-1'),
  Link: TestLink,
  routes: testRoutes,
});

describe('UnifiedAnnotationsPanel — annotations load failure', () => {
  it('reports the failure rather than presenting an empty annotation set as fact', () => {
    renderInEnglish(
      <UnifiedAnnotationsPanel
        {...base()}
        annotationsError={new Error('Resource not found')}
      />,
    );

    expect(screen.getByText(/Could not load annotations/)).toBeInTheDocument();
  });

  it('offers a retry that calls back', () => {
    const onRetryAnnotations = vi.fn();
    renderInEnglish(
      <UnifiedAnnotationsPanel
        {...base()}
        annotationsError={new Error('boom')}
        onRetryAnnotations={onRetryAnnotations}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetryAnnotations).toHaveBeenCalledTimes(1);
  });

  it('says nothing about failure when the annotations are merely empty', () => {
    renderInEnglish(<UnifiedAnnotationsPanel {...base()} />);

    expect(screen.queryByText(/Could not load annotations/)).not.toBeInTheDocument();
  });
});
