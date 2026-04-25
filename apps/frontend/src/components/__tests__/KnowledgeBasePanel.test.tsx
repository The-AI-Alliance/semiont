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

const kb1: KnowledgeBase = { id: 'kb-1', label: 'Production', host: 'prod.example.com', port: 4000, protocol: 'https', email: 'admin@prod.com', gitBranch: 'main' };
const kb2: KnowledgeBase = { id: 'kb-2', label: 'Staging', host: 'staging.example.com', port: 4000, protocol: 'http', email: 'admin@staging.com' };

// vi.hoisted: the mock factory below needs these in scope.
const {
  mockSetActiveKb, mockAddKb, mockRemoveKb, mockUpdateKb, mockSignIn, mockSignOut,
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

vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return {
    ...actual,
    useSemiont: () => mockBrowser,
    defaultProtocol: (host: string) => host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https',
  };
});

vi.mock('@semiont/api-client', async () => {
  const actual = await vi.importActual<typeof import('@semiont/api-client')>('@semiont/api-client');
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
});
