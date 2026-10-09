/**
 * Keystone: the annotation panel family mounts provider-free with a session
 * PROP.
 *
 * ReferencesPanel rendered with a fake session prop and NO SemiontProvider /
 * routing contexts (Link/routes are props; translations come from the English
 * TranslationProvider the test mounts): lists a reference annotation, and an
 * entry click reaches session.client.browse.click — the same interaction the
 * Browser gets, no session provider anywhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderInEnglish } from '../../../../test-utils';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { Annotation, AnnotationId } from '@semiont/core';
import type { RouteBuilder, LinkComponentProps } from '../../../../contexts/RoutingContext';
import { ReferencesPanel } from '../ReferencesPanel';
import { resourceId } from '@semiont/core';

function fakeSession() {
  const client = {
    browse: { click: vi.fn(), tagSchemas: () => ({ subscribe: () => ({ unsubscribe: () => {} }) }) },
    beckon: { hover: vi.fn(), sparkle: vi.fn() },
    mark: { requestDelegate: vi.fn(), delete: vi.fn() },
  };
  const session = {
    client,
    subscribe: () => () => {},
  } as unknown as SemiontSession;
  return { session, client };
}

function referenceAnnotation(): Annotation {
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id: 'ref-1' as AnnotationId,
    type: 'Annotation',
    motivation: 'linking',
    creator: { '@type': 'Person', name: 'user@example.com' },
    created: '2026-07-14T00:00:00Z',
    target: {
      source: 'res-1',
      selector: [
        { type: 'TextQuoteSelector', exact: 'linked text' },
        { type: 'TextPositionSelector', start: 0, end: 11 },
      ],
    },
  } as unknown as Annotation;
}

const TestLink = ({ href, children, ...rest }: LinkComponentProps) => (
  <a href={href} {...rest}>{children}</a>
);
const testRoutes: RouteBuilder = { resourceDetail: (id) => `/r/${id}` };

describe('ReferencesPanel — headless (session prop, no session provider)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts provider-free, lists the reference, and routes an entry click through the session prop', () => {
    const { session, client } = fakeSession();

    renderInEnglish(
      <ReferencesPanel
        session={session}
        resourceId={resourceId('res-1')}
        annotations={[referenceAnnotation()]}
        isDelegating={false}
        progress={null}
        jobId={null}
        pendingAnnotation={null}
        allEntityTypes={[]}
        Link={TestLink}
        routes={testRoutes}
      />,
    );

    const entryText = screen.getByText(/linked text/);
    expect(entryText).toBeInTheDocument();

    fireEvent.click(entryText);
    expect(client.browse.click).toHaveBeenCalledWith('ref-1');
  });

  describe('incoming references — terminal load failure', () => {
    // `referencedByLoading` alone cannot distinguish "still in flight" from
    // "dead" (B15): a panel reading only it renders "Loading..." for ever.

    type PanelProps = React.ComponentProps<typeof ReferencesPanel>;
    const base = (): PanelProps => {
      const { session } = fakeSession();
      return {
        session,
        resourceId: resourceId('res-1' as const),
        annotations: [],
        isDelegating: false,
        progress: null,
        jobId: null,
        pendingAnnotation: null,
        allEntityTypes: [],
        Link: TestLink,
        routes: testRoutes,
      };
    };

    it('reports the failure instead of an endless loading line', () => {
      renderInEnglish(
        <ReferencesPanel
          {...base()}
          referencedBy={[]}
          referencedByLoading
          referencedByError={new Error('Resource not found')}
        />,
      );

      expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
      expect(screen.getByText(/Could not load incoming references/)).toBeInTheDocument();
    });

    it('offers a retry that calls back', () => {
      const onRetryReferencedBy = vi.fn();
      renderInEnglish(
        <ReferencesPanel
          {...base()}
          referencedBy={[]}
          referencedByError={new Error('boom')}
          onRetryReferencedBy={onRetryReferencedBy}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(onRetryReferencedBy).toHaveBeenCalledTimes(1);
    });

    it('with no error, a still-loading list keeps its loading affordance', () => {
      renderInEnglish(
        <ReferencesPanel
          {...base()}
          referencedBy={[]}
          referencedByLoading
        />,
      );

      expect(screen.queryByText(/Could not load incoming references/)).not.toBeInTheDocument();
    });
  });

  describe('entity types — terminal load failure', () => {
    // The picker's empty branch says "no entity types", which is a claim about
    // the knowledge base. On a failed load it is false — the KB may have
    // plenty.

    it('does not present a failed entity-type load as "none exist"', () => {
      const { session } = fakeSession();
      renderInEnglish(
        <ReferencesPanel
          session={session}
          resourceId={resourceId('res-1')}
          annotations={[]}
          isDelegating={false}
          progress={null}
          jobId={null}
          pendingAnnotation={null}
          allEntityTypes={[]}
          entityTypesError={new Error('boom')}
          Link={TestLink}
          routes={testRoutes}
        />,
      );

      expect(screen.queryByText('No entity types available')).not.toBeInTheDocument();
      expect(screen.getByText(/Could not load entity types/)).toBeInTheDocument();
    });
  });
});
