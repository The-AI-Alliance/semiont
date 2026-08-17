import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { EventBus } from '@semiont/core';
import { resourceId as makeResourceId } from '@semiont/core';
import type { SemiontClient, SemiontSession } from '@semiont/sdk';
import { ResourceInfoPanel } from '../ResourceInfoPanel';
import { createTestSemiontWrapper } from '../../../../test-utils';

// Mock TranslationContext
vi.mock('../../../../contexts/TranslationContext', () => ({
  useTranslations: vi.fn(() => (key: string) => {
    const translations: Record<string, string> = {
      locale: 'Locale',
      notSpecified: 'Not specified',
      entityTypeTags: 'Entity Type Tags',
      representation: 'Representation',
      mediaType: 'Media Type',
      byteSize: 'Size',
      storageUri: 'Storage',
      clone: 'Clone',
      cloneDescription: 'Generate a shareable clone link for this resource',
      generate: 'Generate',
      generateDescription: "Generate a new resource from this one's context",
      archive: 'Archive',
      archiveDescription: 'Move this resource to archived status',
      unarchive: 'Unarchive',
      unarchiveDescription: 'Restore this resource to active status',
      provenance: 'Provenance',
      createdAt: 'Created',
      modifiedAt: 'Modified',
      attributedTo: 'Attributed to',
      derivedFrom: 'Derived from',
    };
    return translations[key] || key;
  }),
  TranslationProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock @semiont/http-transport utilities
vi.mock('@semiont/core', async () => {
  const actual = await vi.importActual('@semiont/core');
  return {
    ...actual,
    formatLocaleDisplay: vi.fn((locale: string) => `Language: ${locale}`),
  };
});

// Mock button styles
vi.mock('@/lib/button-styles', () => ({
  buttonStyles: {
    secondary: {
      base: 'px-4 py-2 rounded-lg font-medium',
    },
  },
}));

// Composition-based event tracker
interface TrackedEvent {
  event: string;
  payload: any;
}

function createEventTracker() {
  const events: TrackedEvent[] = [];
  return {
    events,
    clear: () => { events.length = 0; },
    _attach(eventBus: EventBus, client: SemiontClient) {
      // `yield:clone` is a local-bus UI signal emitted by `client.yield.clone()`.
      eventBus.get('yield:clone').subscribe((payload: any) => {
        events.push({ event: 'yield:clone', payload });
      });
      // `mark:archive` / `mark:unarchive` are backend-routed via `actor.emit`;
      // spy on the namespace methods instead of subscribing to a local bus.
      const origArchive = client.mark.archive.bind(client.mark);
      const origUnarchive = client.mark.unarchive.bind(client.mark);
      client.mark.archive = vi.fn(async (rid: any) => {
        events.push({ event: 'mark:archive', payload: { resourceId: rid } });
        return origArchive(rid);
      }) as typeof client.mark.archive;
      client.mark.unarchive = vi.fn(async (rid: any) => {
        events.push({ event: 'mark:unarchive', payload: { resourceId: rid } });
        return origUnarchive(rid);
      }) as typeof client.mark.unarchive;
    },
  };
}

const renderWithEventBus = (component: React.ReactElement<{ session: SemiontSession | null }>, tracker?: ReturnType<typeof createEventTracker>) => {
  const { SemiontWrapper, eventBus, client, session } = createTestSemiontWrapper();
  if (tracker) tracker._attach(eventBus, client);
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <SemiontWrapper>{children}</SemiontWrapper>
  );
  // The component is provider-free: inject the factory session so it is the
  // SAME session whose client the tracker spies on / whose bus it subscribes.
  // The injected session/client are returned too: a test that spies on what the
  // panel calls has to spy on THIS client, not a second factory's.
  return { ...render(React.cloneElement(component, { session }), { wrapper: Wrapper }), session, client };
};

describe('ResourceInfoPanel Component', () => {
  const defaultProps = {
    resourceId: 'test-resource-id',
    documentEntityTypes: [],
    documentLocale: undefined,
    primaryMediaType: undefined,
    primaryByteSize: undefined,
    // Satisfies JSX at element construction only; renderWithEventBus always
    // replaces it (via cloneElement) with the per-test factory session. Never
    // put a live session here — module-scope clients get disposed after the
    // first test.
    session: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render locale section', () => {
      renderWithEventBus(<ResourceInfoPanel {...defaultProps} />);
      expect(screen.getByText('Locale')).toBeInTheDocument();
    });

    it('should render locale when provided', () => {
      renderWithEventBus(<ResourceInfoPanel {...defaultProps} documentLocale="en-US" />);
      // formatLocaleDisplay is mocked to return "Language: {locale}"
      expect(screen.getByText('Language: en-US')).toBeInTheDocument();
    });

    it('should show "not specified" when locale is undefined', () => {
      renderWithEventBus(<ResourceInfoPanel {...defaultProps} documentLocale={undefined} />);
      expect(screen.getByText('Not specified')).toBeInTheDocument();
    });

    it('should render entity type tags when provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          documentEntityTypes={['Person', 'Organization', 'Location']}
        />
      );

      expect(screen.getByText('Entity Type Tags')).toBeInTheDocument();
      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
      expect(screen.getByText('Location')).toBeInTheDocument();
    });

    it('should not render entity type tags section when empty', () => {
      renderWithEventBus(<ResourceInfoPanel {...defaultProps} documentEntityTypes={[]} />);
      expect(screen.queryByText('Entity Type Tags')).not.toBeInTheDocument();
    });

    it('should render representation section when media type provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          primaryMediaType="text/markdown"
        />
      );

      expect(screen.getByText('Representation')).toBeInTheDocument();
      expect(screen.getByText('Media Type')).toBeInTheDocument();
      expect(screen.getByText('text/markdown')).toBeInTheDocument();
    });

    it('should render byte size when provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          primaryByteSize={1024}
        />
      );

      expect(screen.getByText('Representation')).toBeInTheDocument();
      expect(screen.getByText('Size')).toBeInTheDocument();
      expect(screen.getByText('1,024 bytes')).toBeInTheDocument();
    });

    it('should render storageUri when provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          primaryMediaType="text/markdown"
          storageUri="file://docs/overview.md"
        />
      );
      expect(screen.getByText('Storage')).toBeInTheDocument();
      expect(screen.getByText('file://docs/overview.md')).toBeInTheDocument();
    });

    it('should not render storageUri when absent', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          primaryMediaType="text/markdown"
        />
      );
      expect(screen.queryByText('Storage')).not.toBeInTheDocument();
    });

    it('should not render representation section when neither media type nor byte size provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          primaryMediaType={undefined}
          primaryByteSize={undefined}
        />
      );

      expect(screen.queryByText('Representation')).not.toBeInTheDocument();
    });
  });

  describe('Styling and Appearance', () => {
    it('should have proper panel structure', () => {
      const { container } = renderWithEventBus(<ResourceInfoPanel {...defaultProps} />);
      expect(container.querySelector('.semiont-resource-info-panel')).toBeInTheDocument();
    });

    it('should style entity type tags appropriately', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          documentEntityTypes={['TestType']}
        />
      );

      const tag = screen.getByText('TestType');
      expect(tag).toHaveClass('semiont-tag');
      expect(tag).toHaveAttribute('data-variant', 'blue');
    });
  });

  describe('Accessibility', () => {
    it('should have semantic heading structure', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          documentLocale="en-US"
          documentEntityTypes={['Person']}
        />
      );

      const headings = screen.getAllByRole('heading', { level: 3 });
      expect(headings.length).toBeGreaterThan(0);
    });
  });

  describe('Clone Action', () => {
    it('should render clone button', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
        />
      );

      expect(screen.getByRole('button', { name: /Clone/i })).toBeInTheDocument();
      expect(screen.getByText('Generate a shareable clone link for this resource')).toBeInTheDocument();
    });

    it('should emit yield:clone event when clone button clicked', async () => {
      const tracker = createEventTracker();
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
        />,
        tracker
      );

      const button = screen.getByRole('button', { name: /Clone/i });
      fireEvent.click(button);

      await waitFor(() => {
        expect(tracker.events.some(e => e.event === 'yield:clone')).toBe(true);
      });
    });
  });

  describe('Generate Action', () => {
    // The shell's collapsible header is ALSO a button named "Generate", so the
    // form control is targeted by its exact accessible name (the ✨ is part of it).
    it('renders the Generate button when onGenerate is provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel {...defaultProps} onGenerate={() => {}} />
      );
      expect(screen.getByRole('button', { name: '✨ Generate' })).toBeInTheDocument();
      expect(screen.getByText("Generate a new resource from this one's context")).toBeInTheDocument();
    });

    it('hides the Generate button when onGenerate is omitted', () => {
      renderWithEventBus(<ResourceInfoPanel {...defaultProps} />);
      expect(screen.queryByRole('button', { name: '✨ Generate' })).not.toBeInTheDocument();
    });

    it('calls onGenerate when clicked', () => {
      const onGenerate = vi.fn();
      renderWithEventBus(
        <ResourceInfoPanel {...defaultProps} onGenerate={onGenerate} />
      );
      fireEvent.click(screen.getByRole('button', { name: '✨ Generate' }));
      expect(onGenerate).toHaveBeenCalledTimes(1);
    });

    // ── GENERATE-FROM-RESOURCE P2 (D7/D8): the panel is the progress surface ──

    it('the Generate control lives inside the assist shell (D7)', () => {
      const { container } = renderWithEventBus(
        <ResourceInfoPanel {...defaultProps} onGenerate={() => {}}
          isGenerating={false} generationProgress={null} />
      );
      const shell = container.querySelector('.semiont-assist-widget[data-type="generation"]');
      expect(shell).not.toBeNull();
      expect(shell!.querySelector('button')).not.toBeNull(); // the form IS the Generate control
    });

    it('progress replaces the Generate form while a generation runs', () => {
      const { container } = renderWithEventBus(
        <ResourceInfoPanel {...defaultProps} onGenerate={() => {}}
          isGenerating
          generationProgress={{ percentage: 40, message: { code: 'generating-resource' } }} />
      );
      expect(container.querySelector('.semiont-assist-progress')).not.toBeNull();
      expect(screen.queryByRole('button', { name: '✨ Generate' })).toBeNull();
    });

    it('the ended frame links the generated resource by name, and dismisses (D8)', () => {
      const onDismissProgress = vi.fn();
      const { client } = renderWithEventBus(
        <ResourceInfoPanel {...defaultProps} onGenerate={() => {}}
          isGenerating={false}
          generationProgress={{ percentage: 100, message: { code: 'complete-generated' } }}
          generationOutcome={{
            resourceId: makeResourceId('urn:semiont:resource:new1'),
            resourceName: 'Summary of PB',
          }}
          onDismissProgress={onDismissProgress} />
      );
      const openSpy = vi.spyOn(client.browse, 'openResource');

      fireEvent.click(screen.getByRole('button', { name: 'Summary of PB' }));
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(String(openSpy.mock.calls[0]![0])).toBe('urn:semiont:resource:new1');

      fireEvent.click(screen.getByTestId('semiont-assist-control'));
      expect(onDismissProgress).toHaveBeenCalledTimes(1);
    });

    it('no outcome, no link: the ended frame renders without one until job:complete arrives', () => {
      renderWithEventBus(
        <ResourceInfoPanel {...defaultProps} onGenerate={() => {}}
          isGenerating={false}
          generationProgress={{ percentage: 100, message: { code: 'complete-generated' } }}
          generationOutcome={null} />
      );
      expect(screen.queryByText('Summary of PB')).toBeNull();
    });
  });

  describe('Provenance Section', () => {
    it('should not render provenance section when no provenance data', () => {
      renderWithEventBus(<ResourceInfoPanel {...defaultProps} />);
      expect(screen.queryByText('Provenance')).not.toBeInTheDocument();
    });

    it('should render dateCreated when provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel {...defaultProps} dateCreated="2024-01-15T10:30:00Z" />
      );
      expect(screen.getByText('Provenance')).toBeInTheDocument();
      expect(screen.getByText('Created')).toBeInTheDocument();
    });

    it('should render dateModified when provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel {...defaultProps} dateModified="2024-06-01T12:00:00Z" />
      );
      expect(screen.getByText('Provenance')).toBeInTheDocument();
      expect(screen.getByText('Modified')).toBeInTheDocument();
    });

    it('should render a single agent attribution', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          wasAttributedTo={{ '@type': 'Person', name: 'Alice', '@id': 'https://example.org/alice' }}
        />
      );
      expect(screen.getByText('Attributed to')).toBeInTheDocument();
      expect(screen.getByText('Alice')).toBeInTheDocument();
    });

    it('should render multiple agent attributions', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          wasAttributedTo={[
            { '@type': 'Person', name: 'Alice' },
            { '@type': 'Person', name: 'Bob' },
          ]}
        />
      );
      expect(screen.getByText('Alice, Bob')).toBeInTheDocument();
    });

    it('should render wasDerivedFrom when provided', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          wasDerivedFrom="urn:semiont:resource:abc123"
        />
      );
      expect(screen.getByText('Derived from')).toBeInTheDocument();
      expect(screen.getByText('urn:semiont:resource:abc123')).toBeInTheDocument();
    });

    it('a derived-from id is a LINK, and clicking it opens that resource', () => {
      // Rendering the id is half the feature; the provenance chain is only
      // walkable if the id navigates. The click goes through the session's
      // client, so a panel handed no session must not throw either — the
      // optional chain below is load-bearing, not defensive noise.
      // `renderWithEventBus` injects its own per-test session via cloneElement,
      // so the spy has to go on THAT client — one created here would never be
      // the one the button calls.
      const { client } = renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          wasDerivedFrom="urn:semiont:resource:abc123"
        />
      );
      const openSpy = vi.spyOn(client.browse, 'openResource');

      fireEvent.click(screen.getByText('urn:semiont:resource:abc123'));
      expect(openSpy).toHaveBeenCalledTimes(1);
      expect(String(openSpy.mock.calls[0]![0])).toBe('urn:semiont:resource:abc123');
    });

    it('renders every id when the resource derives from several', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          wasDerivedFrom={['urn:semiont:resource:a', 'urn:semiont:resource:b'] as never}
        />
      );
      // The separator lives inside the button (`{i > 0 && ', '}{id}`), so the
      // second one's text node is ", urn:…:b" — matched loosely on purpose.
      expect(screen.getByText(/urn:semiont:resource:a/)).toBeInTheDocument();
      expect(screen.getByText(/urn:semiont:resource:b/)).toBeInTheDocument();
    });

    it('falls back to generator for attribution when wasAttributedTo is absent', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          generator={{ '@type': 'Software', name: 'Semiont AI' } as never}
        />
      );
      expect(screen.getByText('Attributed to')).toBeInTheDocument();
      expect(screen.getByText('Semiont AI')).toBeInTheDocument();
    });

    it('renders Software peers as `${provider} ${model}` from structured fields', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          generator={{
            '@type': 'Software',
            '@id': 'did:web:example.com:agents:ollama:gemma2%3A27b',
            name: 'ignored',
            provider: 'ollama',
            model: 'gemma2:27b',
          } as never}
        />
      );
      expect(screen.getByText('ollama gemma2:27b')).toBeInTheDocument();
    });
  });

  describe('Archive Actions', () => {
    it('should render archive button when not archived', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          isArchived={false}
        />
      );

      expect(screen.getByRole('button', { name: /Archive/i })).toBeInTheDocument();
      expect(screen.getByText('Move this resource to archived status')).toBeInTheDocument();
    });

    it('should render unarchive button when archived', () => {
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          isArchived={true}
        />
      );

      expect(screen.getByRole('button', { name: /Unarchive/i })).toBeInTheDocument();
      expect(screen.getByText('Restore this resource to active status')).toBeInTheDocument();
    });

    it('should emit mark:archive event when archive button clicked', async () => {
      const tracker = createEventTracker();
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          isArchived={false}
        />,
        tracker
      );

      const button = screen.getByRole('button', { name: /Archive/i });
      fireEvent.click(button);

      await waitFor(() => {
        expect(tracker.events.some(e => e.event === 'mark:archive')).toBe(true);
      });
    });

    it('should emit mark:unarchive event when unarchive button clicked', async () => {
      const tracker = createEventTracker();
      renderWithEventBus(
        <ResourceInfoPanel
          {...defaultProps}
          isArchived={true}
        />,
        tracker
      );

      const button = screen.getByRole('button', { name: /Unarchive/i });
      fireEvent.click(button);

      await waitFor(() => {
        expect(tracker.events.some(e => e.event === 'mark:unarchive')).toBe(true);
      });
    });
  });
});
