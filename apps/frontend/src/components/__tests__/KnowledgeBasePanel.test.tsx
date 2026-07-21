import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgeBasePanel } from '../KnowledgeBasePanel';
import type { KnowledgeBase } from '@semiont/sdk';
const translations: Record<string, string> = {
  'KnowledgeBasePanel.title': 'Knowledge Bases',
  'KnowledgeBasePanel.connectTitle': 'Connect to Knowledge Base',
  'KnowledgeBasePanel.connect': 'Connect',
  'KnowledgeBasePanel.connecting': 'Connecting...',
  'KnowledgeBasePanel.signIn': 'Sign in',
  'KnowledgeBasePanel.signingIn': 'Signing in...',
  'KnowledgeBasePanel.cancel': 'Cancel',
  'KnowledgeBasePanel.addKnowledgeBase': 'Add knowledge base',
  'KnowledgeBasePanel.remove': 'Remove',
  'KnowledgeBasePanel.signOut': 'Sign out',
  'KnowledgeBasePanel.statusConnected': 'Connected',
  'KnowledgeBasePanel.statusExpired': 'Session expired',
  'KnowledgeBasePanel.statusSignedOut': 'Signed out',
  'KnowledgeBasePanel.statusUnreachable': 'Unreachable',
  'KnowledgeBasePanel.discoveredTitle': 'Found on this machine',
  'KnowledgeBasePanel.managedBadge': 'Managed by launcher',
  'KnowledgeBasePanel.placementLocal': 'local',
  'KnowledgeBasePanel.placementCodespace': 'codespace',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: any) => {
      let val = translations[key] ?? key;
      if (params?.label) val = val.replace('{{label}}', params.label);
      return val;
    },
    i18n: { language: 'en' },
  }),
}));

const kb1: KnowledgeBase = {
  id: 'kb-1',
  label: 'Production',
  email: 'admin@prod.com',
  gitBranch: 'main',
  endpoint: { kind: 'http', host: 'prod.example.com', port: 4000, protocol: 'https' },
};
const kb2: KnowledgeBase = {
  id: 'kb-2',
  label: 'Staging',
  email: 'admin@staging.com',
  endpoint: { kind: 'http', host: 'staging.example.com', port: 4000, protocol: 'http' },
};

// vi.hoisted: the mock factory below needs these in scope.
const {
  
  kbs$, activeSession$, mockBrowser,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { BehaviorSubject } = require('rxjs');
  const kbs$ = new BehaviorSubject([] as any);
  const activeSession$ = new BehaviorSubject(null);
  const mockBrowser = {
    kbs$,
    activeSession$,
    activeKbId$: new BehaviorSubject(null),
    setActiveKb: vi.fn(),
    addKb: vi.fn(),
    removeKb: vi.fn(),
    updateKb: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
    getKbSessionStatus: (id: string) => id === 'kb-1' ? 'authenticated' : 'signed-out',
  };
  return {
    mockSetActiveKb: mockBrowser.setActiveKb,
    mockAddKb: mockBrowser.addKb,
    mockRemoveKb: mockBrowser.removeKb,
    mockUpdateKb: mockBrowser.updateKb,
    mockSignIn: mockBrowser.signIn,
    mockSignOut: mockBrowser.signOut,
    kbs$,
    activeSession$,
    mockBrowser,
  };
});

// Launcher discovery (P5): the panel binds useKBDiscovery; tests script it
// through this holder (reset in beforeEach, set per test).
const discoveryHolder = vi.hoisted(() => ({
  current: { state: null, kbs: [] } as {
    state: import('@semiont/sdk').DiscoveryState | null;
    kbs: import('@semiont/core').DiscoveredKB[];
  },
}));

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    useSemiont: () => mockBrowser,
    useKBDiscovery: () => discoveryHolder.current,
    defaultProtocol: (host: string) => host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https',
  };
});

vi.mock('@semiont/http-transport', async () => {
  const actual = await vi.importActual<typeof import('@semiont/http-transport')>('@semiont/http-transport');
  return {
    ...actual,
    SemiontClient: vi.fn(),
  };
});

vi.mock('@semiont/core', async () => {
  const actual = await vi.importActual<typeof import('@semiont/core')>('@semiont/core');
  return {
    ...actual,
    baseUrl: (url: string) => url,
    email: (e: string) => e,
    accessToken: (t: string) => t,
  };
});

describe('KnowledgeBasePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kbs$.next([kb1, kb2]);
    // Panel reads `activeKnowledgeBase` from `activeSession$?.kb`, so a session
    // with `kb: kb1` emulates "kb1 is active".
    activeSession$.next({ kb: kb1 } as any);
  });

  describe('Rendering', () => {
    it('should render the panel title', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByRole('heading', { name: /Knowledge Bases/ })).toBeInTheDocument();
    });

    it('should render all knowledge bases', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByText('Production')).toBeInTheDocument();
      expect(screen.getByText('Staging')).toBeInTheDocument();
    });

    it('should display host:port for each KB', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByText('prod.example.com:4000 · main')).toBeInTheDocument();
      expect(screen.getByText('staging.example.com:4000')).toBeInTheDocument();
    });

    it('should display gitBranch when present', () => {
      render(<KnowledgeBasePanel />);
      // kb1 has gitBranch: 'main'
      expect(screen.getByText(/· main/)).toBeInTheDocument();
    });

    it('should not display branch separator when gitBranch is absent', () => {
      render(<KnowledgeBasePanel />);
      // kb2 has no gitBranch — should show host:port only, no ·
      const stagingText = screen.getByText('staging.example.com:4000');
      expect(stagingText.textContent).not.toContain('·');
    });

    it('should render the Add knowledge base button', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByText('Add knowledge base')).toBeInTheDocument();
    });

    it('should auto-open the connect form when no KBs are configured', () => {
      kbs$.next([]);
      activeSession$.next(null);
      render(<KnowledgeBasePanel />);
      expect(screen.getByRole('heading', { name: /Knowledge Bases/ })).toBeInTheDocument();
      expect(screen.getByText('Connect to Knowledge Base')).toBeInTheDocument();
    });
  });

  describe('Add knowledge base', () => {
    it('should open the connect form when Add is clicked', async () => {
      const user = userEvent.setup();
      render(<KnowledgeBasePanel />);

      await user.click(screen.getByText('Add knowledge base'));

      expect(screen.getByText('Connect to Knowledge Base')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Host')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Port')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Email')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Password')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have a heading for the panel', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByRole('heading', { name: /Knowledge Bases/ })).toBeInTheDocument();
    });
  });

  describe('Launcher discovery (P5)', () => {
    const discoveredLocal = {
      host: 'localhost',
      port: 4001,
      placement: 'local' as const,
      managedBy: 'semiont-launcher',
      did: 'did:web:local.example',
      siteName: 'Local KB',
    };
    // Same endpoint as kb1 ('Production', prod.example.com:4000) — the collision.
    const discoveredProd = {
      host: 'prod.example.com',
      port: 4000,
      placement: 'codespace' as const,
      managedBy: 'semiont-launcher',
      did: 'did:web:prod.example',
      siteName: 'Production KB',
    };

    beforeEach(() => {
      discoveryHolder.current = { state: null, kbs: [] };
    });

    it('renders launcher-discovered KBs in their own section', () => {
      discoveryHolder.current = { state: { kind: 'managed', kbs: [discoveredLocal] }, kbs: [discoveredLocal] };
      render(<KnowledgeBasePanel />);

      expect(screen.getByText('Found on this machine')).toBeInTheDocument();
      expect(screen.getByText('Local KB')).toBeInTheDocument();
      expect(screen.getByText(/localhost:4001/)).toBeInTheDocument();
      expect(screen.getByText('local')).toBeInTheDocument();
    });

    it('clicking a discovered KB opens the login form prefilled with its endpoint', async () => {
      discoveryHolder.current = { state: { kind: 'managed', kbs: [discoveredLocal] }, kbs: [discoveredLocal] };
      const user = userEvent.setup();
      render(<KnowledgeBasePanel />);

      await user.click(screen.getByText('Local KB'));

      expect(screen.getByPlaceholderText('Host')).toHaveValue('localhost');
      expect(screen.getByPlaceholderText('Port')).toHaveValue(4001);
    });

    it('adopts a collision: one row, managed badge, no discovered section', () => {
      discoveryHolder.current = { state: { kind: 'managed', kbs: [discoveredProd] }, kbs: [discoveredProd] };
      render(<KnowledgeBasePanel />);

      // The registered row renders once (its registered label, not the
      // discovered siteName), gains the managed badge, and the registry is
      // untouched (adoption is render-only and reversible).
      expect(screen.getByText('Production')).toBeInTheDocument();
      expect(screen.queryByText('Production KB')).not.toBeInTheDocument();
      expect(screen.getByTitle('Managed by launcher')).toBeInTheDocument();
      expect(screen.getByText('codespace')).toBeInTheDocument();
      expect(screen.queryByText('Found on this machine')).not.toBeInTheDocument();
    });

    it('renders the panel unchanged when discovery is absent', () => {
      discoveryHolder.current = { state: { kind: 'absent', reason: 'not-found' }, kbs: [] };
      render(<KnowledgeBasePanel />);

      expect(screen.queryByText('Found on this machine')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Managed by launcher')).not.toBeInTheDocument();
      expect(screen.getByText('Production')).toBeInTheDocument();
      expect(screen.getByText('Staging')).toBeInTheDocument();
    });

    it('removal is projection-only: discovered rows vanish, adopted rows just lose the badge', () => {
      discoveryHolder.current = {
        state: { kind: 'managed', kbs: [discoveredLocal, discoveredProd] },
        kbs: [discoveredLocal, discoveredProd],
      };
      const { rerender } = render(<KnowledgeBasePanel />);
      expect(screen.getByText('Local KB')).toBeInTheDocument();
      // Two badges: the adopted registered row's and the discovered row's.
      expect(screen.getAllByTitle('Managed by launcher')).toHaveLength(2);

      // The launcher stops managing everything.
      discoveryHolder.current = { state: { kind: 'managed', kbs: [] }, kbs: [] };
      rerender(<KnowledgeBasePanel />);

      expect(screen.queryByText('Local KB')).not.toBeInTheDocument();
      expect(screen.queryByTitle('Managed by launcher')).not.toBeInTheDocument();
      // The adopted row survives — it is the user's registered KB.
      expect(screen.getByText('Production')).toBeInTheDocument();
    });
  });
});
