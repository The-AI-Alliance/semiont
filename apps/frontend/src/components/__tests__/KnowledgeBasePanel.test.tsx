import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgeBasePanel } from '../KnowledgeBasePanel';
import type { KnowledgeBase } from '@/contexts/KnowledgeBaseContext';

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

const mockSetActiveKnowledgeBase = vi.fn();
const mockAddKnowledgeBase = vi.fn();
const mockRemoveKnowledgeBase = vi.fn();
const mockUpdateKnowledgeBase = vi.fn();
const mockSignOut = vi.fn();

const kb1: KnowledgeBase = { id: 'kb-1', label: 'Production', host: 'prod.example.com', port: 4000, protocol: 'https', email: 'admin@prod.com' };
const kb2: KnowledgeBase = { id: 'kb-2', label: 'Staging', host: 'staging.example.com', port: 4000, protocol: 'http', email: 'admin@staging.com' };

let mockKnowledgeBases: KnowledgeBase[] = [kb1, kb2];
let mockActiveKnowledgeBase: KnowledgeBase | null = kb1;

vi.mock('@/contexts/KnowledgeBaseContext', () => ({
  useKnowledgeBaseContext: () => ({
    get knowledgeBases() { return mockKnowledgeBases; },
    get activeKnowledgeBase() { return mockActiveKnowledgeBase; },
    setActiveKnowledgeBase: mockSetActiveKnowledgeBase,
    addKnowledgeBase: mockAddKnowledgeBase,
    removeKnowledgeBase: mockRemoveKnowledgeBase,
    updateKnowledgeBase: mockUpdateKnowledgeBase,
    signOut: mockSignOut,
  }),
  defaultProtocol: (host: string) => host === 'localhost' || host === '127.0.0.1' ? 'http' : 'https',
  getKbSessionStatus: (id: string) => id === kb1.id ? 'authenticated' : 'signed-out',
  setKbToken: vi.fn(),
}));

vi.mock('@semiont/api-client', () => ({
  SemiontApiClient: vi.fn(),
}));

vi.mock('@semiont/core', () => ({
  baseUrl: (url: string) => url,
  email: (e: string) => e,
  accessToken: (t: string) => t,
  EventBus: vi.fn(),
}));

describe('KnowledgeBasePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockKnowledgeBases = [kb1, kb2];
    mockActiveKnowledgeBase = kb1;
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
      expect(screen.getByText('prod.example.com:4000')).toBeInTheDocument();
      expect(screen.getByText('staging.example.com:4000')).toBeInTheDocument();
    });

    it('should render the Add knowledge base button', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByText('Add knowledge base')).toBeInTheDocument();
    });

    it('should auto-open the connect form when no KBs are configured', () => {
      mockKnowledgeBases = [];
      mockActiveKnowledgeBase = null;
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
