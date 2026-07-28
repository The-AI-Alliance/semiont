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
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import { UnifiedAnnotationsPanel } from '../UnifiedAnnotationsPanel';
import { ANNOTATORS } from '../../../../lib/annotation-registry';

const TestLink = ({ href, children, ...rest }: any) => <a href={href} {...rest}>{children}</a>;
const testRoutes = { resourceDetail: (id: string) => `/r/${id}` } as any;

function fakeSession(): SemiontSession {
  return {
    client: { browse: { click: vi.fn() }, beckon: { hover: vi.fn() } },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

const base = () => ({
  session: fakeSession(),
  annotations: [],
  annotators: ANNOTATORS,
  allEntityTypes: [],
  pendingAnnotation: null,
  resourceId: 'res-1',
  Link: TestLink,
  routes: testRoutes,
});

describe('UnifiedAnnotationsPanel — annotations load failure', () => {
  it('reports the failure rather than presenting an empty annotation set as fact', () => {
    render(
      <UnifiedAnnotationsPanel
        {...(base() as any)}
        annotationsError={new Error('Resource not found')}
      />,
    );

    expect(screen.getByText(/Could not load annotations/)).toBeInTheDocument();
  });

  it('offers a retry that calls back', () => {
    const onRetryAnnotations = vi.fn();
    render(
      <UnifiedAnnotationsPanel
        {...(base() as any)}
        annotationsError={new Error('boom')}
        onRetryAnnotations={onRetryAnnotations}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetryAnnotations).toHaveBeenCalledTimes(1);
  });

  it('says nothing about failure when the annotations are merely empty', () => {
    render(<UnifiedAnnotationsPanel {...(base() as any)} />);

    expect(screen.queryByText(/Could not load annotations/)).not.toBeInTheDocument();
  });
});
