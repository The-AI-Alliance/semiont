/**
 * BROWSER-KB-DISCOVERY follow-up — the /know empty state knows about
 * launcher-discovered KBs: with zero registered KBs but a launcher managing
 * some, it says so and points at the panel instead of only linking docs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiscoverEmptyState } from '../layout';

const translations: Record<string, string> = {
  'DiscoverEmptyState.noKnowledgeBases': 'No knowledge bases',
  'DiscoverEmptyState.noKnowledgeBasesHint': 'Add a knowledge base using the panel on the right to start discovering, annotating, and linking resources.',
  'DiscoverEmptyState.findKnowledgeBases': 'Find knowledge bases',
  'DiscoverEmptyState.createNew': 'Create a new one',
  'DiscoverEmptyState.discoveredOnMachine': '{{count}} knowledge base(s) found running on this machine — connect from the panel on the right.',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      let val = translations[key] ?? key;
      if (params) {
        Object.entries(params).forEach(([k, v]) => { val = val.replace(`{{${k}}}`, String(v)); });
      }
      return val;
    },
    i18n: { language: 'en' },
  }),
}));

const discoveryHolder = vi.hoisted(() => ({
  current: { state: null, kbs: [] } as {
    state: import('@semiont/sdk').DiscoveryState | null;
    kbs: import('@semiont/core').DiscoveredKB[];
  },
}));

const { kbs$, activeSession$, mockBrowser } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BehaviorSubject } = require('rxjs');
  const kbs$ = new BehaviorSubject([]);
  const activeSession$ = new BehaviorSubject(null);
  const mockBrowser = {
    kbs$,
    activeSession$,
    getKbSessionStatus: () => 'signed-out',
  };
  return { kbs$, activeSession$, mockBrowser };
});

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    useSemiont: () => mockBrowser,
    useKBDiscovery: () => discoveryHolder.current,
  };
});

const DISCOVERED = {
  host: 'localhost',
  port: 4001,
  placement: 'local' as const,
  managedBy: 'semiont-launcher',
  siteName: 'Local KB',
};

describe('DiscoverEmptyState — launcher discovery', () => {
  beforeEach(() => {
    kbs$.next([]);
    activeSession$.next(null);
    discoveryHolder.current = { state: null, kbs: [] };
  });

  it('mentions discovered KBs when the launcher manages some and none are registered', () => {
    discoveryHolder.current = {
      state: { kind: 'managed', kbs: [DISCOVERED, { ...DISCOVERED, port: 4002 }] },
      kbs: [DISCOVERED, { ...DISCOVERED, port: 4002 }],
    };
    render(<DiscoverEmptyState />);

    expect(screen.getByText('No knowledge bases')).toBeInTheDocument();
    expect(screen.getByText(/2 knowledge base\(s\) found running on this machine/)).toBeInTheDocument();
  });

  it('shows only the stock copy when discovery finds nothing', () => {
    render(<DiscoverEmptyState />);

    expect(screen.getByText('No knowledge bases')).toBeInTheDocument();
    expect(screen.queryByText(/found running on this machine/)).not.toBeInTheDocument();
    expect(screen.getByText('Find knowledge bases')).toBeInTheDocument();
  });
});
