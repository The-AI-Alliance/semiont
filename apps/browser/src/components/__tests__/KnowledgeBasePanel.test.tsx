import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgeBasePanel } from '../KnowledgeBasePanel';
import { SignInError, type KnowledgeBase } from '@semiont/sdk';
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
  'KnowledgeBasePanel.unknownName': 'Unknown',
  'KnowledgeBasePanel.addressConflict': '{{count}} knowledge bases claim {{address}} — one is likely stale.',
  'KnowledgeBasePanel.connectToAddress': 'Connect to {{address}}',
  'KnowledgeBasePanel.anotherCopy': "another copy of the knowledge base you're connected to",
  'KnowledgeBasePanel.discoveredTitle': 'Found on this machine',
  'KnowledgeBasePanel.managedBadge': 'Managed by launcher',
  'KnowledgeBasePanel.placementLocal': 'local',
  'KnowledgeBasePanel.placementCodespace': 'codespace',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: any) => {
      let val = translations[key] ?? key;
      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          val = val.replace(`{{${k}}}`, String(v));
        });
      }
      return val;
    },
    i18n: { language: 'en' },
  }),
}));

const kb1: KnowledgeBase = {
  id: 'kb-1',
  did: 'did:web:prod.example',
  label: 'Production',
  email: 'admin@prod.com',
  gitBranch: 'main',
  endpoint: { kind: 'http', host: 'prod.example.com', port: 4000, protocol: 'https' },
};
const kb2: KnowledgeBase = {
  id: 'kb-2',
  did: 'did:web:staging.example',
  label: 'Staging',
  email: 'admin@staging.com',
  endpoint: { kind: 'http', host: 'staging.example.com', port: 4000, protocol: 'http' },
};

// vi.hoisted: the mock factory below needs these in scope.
const {
  kbs$, activeSession$, mockBrowser, mockEmit,
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
    beginSignIn: vi.fn(),
    signOut: vi.fn(),
    getKbSessionStatus: (id: string) => id === 'kb-1' ? 'authenticated' : 'signed-out',
    emit: vi.fn(),
  };
  return {
    kbs$,
    activeSession$,
    mockBrowser,
    mockEmit: mockBrowser.emit,
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

const pathHolder = vi.hoisted(() => ({ current: '/know/discover' }));

vi.mock('@/i18n/routing', () => ({
  usePathname: () => pathHolder.current,
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

// Connecting is leaving: the panel hands the browser a target and navigates
// to the URL it returns. jsdom's `location.assign` is not implemented, so
// the navigation is recorded here.
const assign = vi.fn();
const ISSUER_URL = 'https://issuer.test/realms/semiont/protocol/openid-connect/auth?client_id=semiont-browser';

describe('KnowledgeBasePanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'http://localhost:3000', href: 'http://localhost:3000/en/know/discover', assign },
    });
    mockBrowser.beginSignIn.mockResolvedValue(ISSUER_URL);
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

    it('should display host:port for each KB, with a placeholder for a missing branch', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByText('prod.example.com:4000 · main')).toBeInTheDocument();
      // Fixed shape: the branch slot renders '–' rather than disappearing.
      expect(screen.getByText('staging.example.com:4000 · –')).toBeInTheDocument();
    });

    it('should display gitBranch when present', () => {
      render(<KnowledgeBasePanel />);
      // kb1 has gitBranch: 'main'
      expect(screen.getByText(/· main/)).toBeInTheDocument();
    });

    it('should display the placeholder in the branch slot when gitBranch is absent', () => {
      // Fixed shape (2026-07-21 identity decision): the slot renders '–'
      // rather than disappearing — a missing field is a visible gap.
      render(<KnowledgeBasePanel />);
      expect(screen.getByText('staging.example.com:4000 · –')).toBeInTheDocument();
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
    it('should open the connect form when Add is clicked — an address, never a credential', async () => {
      const user = userEvent.setup();
      render(<KnowledgeBasePanel />);

      await user.click(screen.getByText('Add knowledge base'));

      expect(screen.getByText('Connect to Knowledge Base')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Host')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Port')).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Email')).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have a heading for the panel', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByRole('heading', { name: /Knowledge Bases/ })).toBeInTheDocument();
    });
  });

  describe('Connect starts a sign-in at the issuer the KB trusts', () => {
    // Who the user is comes from the issuer, so the panel's whole job at
    // connect time is: hand the browser a target, go where it says. The
    // identity capture and the (C) verification happen on the way back, in
    // the callback page — see its tests.
    async function connect() {
      const user = userEvent.setup();
      render(<KnowledgeBasePanel />);
      await user.click(screen.getByText('Add knowledge base'));
      await user.click(screen.getByRole('button', { name: 'Connect' }));
    }

    it('asks the browser to begin a sign-in for the typed address, and navigates to the issuer', async () => {
      await connect();

      await waitFor(() => expect(assign).toHaveBeenCalledWith(ISSUER_URL));
      expect(mockBrowser.beginSignIn).toHaveBeenCalledWith({
        target: { kind: 'http', host: 'localhost', port: 4000, protocol: 'http' },
        redirectUri: 'http://localhost:3000/en/auth/callback',
      });
    });

    it('re-authenticates a registered KB at the typed address by id rather than registering it twice', async () => {
      const user = userEvent.setup();
      render(<KnowledgeBasePanel />);
      await user.click(screen.getByText('Add knowledge base'));
      const host = screen.getByPlaceholderText('Host');
      await user.clear(host);
      await user.type(host, 'staging.example.com');
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      await waitFor(() => expect(assign).toHaveBeenCalled());
      expect(mockBrowser.beginSignIn).toHaveBeenCalledWith(expect.objectContaining({ kbId: 'kb-2' }));
    });

    it('says why when the knowledge base trusts no issuer, and stays', async () => {
      mockBrowser.beginSignIn.mockRejectedValue(new SignInError('no-issuer', 'The knowledge base trusts no external issuer'));

      await connect();

      await waitFor(() => {
        expect(screen.getByText(/trusts no external issuer/i)).toBeInTheDocument();
      });
      expect(assign).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled();
    });

    it('offers a signed-out KB one button back to its issuer', async () => {
      const user = userEvent.setup();
      render(<KnowledgeBasePanel />);

      // kb2 reads 'signed-out'; clicking it opens the re-auth prompt.
      await user.click(screen.getByText('Staging'));
      expect(screen.getByText('admin@staging.com')).toBeInTheDocument();
      expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      await waitFor(() => expect(assign).toHaveBeenCalledWith(ISSUER_URL));
      expect(mockBrowser.beginSignIn).toHaveBeenCalledWith({
        target: kb2.endpoint,
        redirectUri: 'http://localhost:3000/en/auth/callback',
        kbId: 'kb-2',
      });
    });

    it('renders "Unknown" for a registered KB with no name (decision 7 vocabulary)', () => {
      kbs$.next([{ ...kb1, label: '' }]);
      render(<KnowledgeBasePanel />);

      expect(screen.getByText('Unknown')).toBeInTheDocument();
      // The address still renders on the address line, where it belongs.
      expect(screen.getByText(/prod\.example\.com:4000/)).toBeInTheDocument();
    });
  });

  describe('Identity join (P3b — decision 9: look up by address, verify by did)', () => {
    beforeEach(() => {
      discoveryHolder.current = { state: null, kbs: [] };
    });

    it('adopts the entry at its address when the did verifies', () => {
      // kb1 = prod.example.com:4000, did:web:prod.example
      const mine = {
        host: 'prod.example.com', port: 4000, placement: 'local' as const,
        managedBy: 'semiont-launcher', did: 'did:web:prod.example', repo: 'org/prod-kb',
      };
      discoveryHolder.current = { state: { kind: 'managed', kbs: [mine] }, kbs: [mine] };
      render(<KnowledgeBasePanel />);

      const row = screen.getByText('Production').closest('.semiont-panel-item') as HTMLElement;
      expect(within(row).getByTitle('Managed by launcher')).toBeInTheDocument();
      expect(within(row).getByText('org/prod-kb')).toBeInTheDocument();
      expect(screen.queryByText('Found on this machine')).not.toBeInTheDocument();
    });

    it('does NOT adopt when the address matches but the did does not — someone else is there', () => {
      // The live defect, now caught by verification rather than merely disarmed:
      // a single entry at my address that is a DIFFERENT knowledge base.
      const notMine = {
        host: 'prod.example.com', port: 4000, placement: 'codespace' as const,
        managedBy: 'semiont-launcher', did: 'did:web:pingel-org.github.io:synthetic-family',
        repo: 'pingel-org/synthetic-family',
      };
      discoveryHolder.current = { state: { kind: 'managed', kbs: [notMine] }, kbs: [notMine] };
      render(<KnowledgeBasePanel />);

      const row = screen.getByText('Production').closest('.semiont-panel-item') as HTMLElement;
      expect(within(row).queryByTitle('Managed by launcher')).not.toBeInTheDocument();
      expect(within(row).queryByText('pingel-org/synthetic-family')).not.toBeInTheDocument();
      // Unadopted, so it stays visible as its own discovered entry.
      expect(screen.getByText('Found on this machine')).toBeInTheDocument();
      expect(screen.getByText('pingel-org/synthetic-family')).toBeInTheDocument();
    });

    it('renders one KB in two places as two rows — never merged, never a conflict', () => {
      // Decision 9: a local clone and a codespace of one repo share a did and
      // will be COMMON. Distinct running copies with distinct health.
      const localCopy = {
        host: 'localhost', port: 4000, placement: 'local' as const,
        managedBy: 'semiont-launcher', did: 'did:web:twin.example', repo: 'org/twin-kb',
      };
      const codespaceCopy = { ...localCopy, port: 4001, placement: 'codespace' as const };
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      discoveryHolder.current = {
        state: { kind: 'managed', kbs: [localCopy, codespaceCopy] },
        kbs: [localCopy, codespaceCopy],
      };
      render(<KnowledgeBasePanel />);

      // Both copies render, each at its own address.
      expect(screen.getByText('localhost:4000')).toBeInTheDocument();
      expect(screen.getByText('localhost:4001')).toBeInTheDocument();
      // Two rows keyed distinctly — a did-based key would collide here.
      expect(errorSpy.mock.calls.flat().join(' ')).not.toMatch(/same key/i);
      errorSpy.mockRestore();
    });
  });

  describe('Twin copies (P3c — Option 2: mark the relationship)', () => {
    beforeEach(() => {
      discoveryHolder.current = { state: null, kbs: [] };
    });

    it('marks a discovered copy of a KB you are already connected to', () => {
      // kb1 (did:web:prod.example) is registered at prod.example.com:4000.
      // The launcher also publishes a codespace copy of the SAME KB elsewhere.
      const mine = {
        host: 'prod.example.com', port: 4000, placement: 'local' as const,
        managedBy: 'semiont-launcher', did: 'did:web:prod.example', repo: 'org/prod-kb',
        siteName: 'Production',
      };
      const twin = { ...mine, host: 'localhost', port: 4002, placement: 'codespace' as const };
      discoveryHolder.current = { state: { kind: 'managed', kbs: [mine, twin] }, kbs: [mine, twin] };

      render(<KnowledgeBasePanel />);

      // The twin renders as its own row (never merged — decision 9) …
      const twinRow = screen.getByText('localhost:4002').closest('.semiont-panel-item') as HTMLElement;
      // … and says WHY it looks like a duplicate.
      expect(within(twinRow).getByText(/another copy of the knowledge base/i)).toBeInTheDocument();
    });

    it('does not mark an unrelated discovered KB', () => {
      const stranger = {
        host: 'localhost', port: 4002, placement: 'codespace' as const,
        managedBy: 'semiont-launcher', did: 'did:web:stranger.example', repo: 'org/stranger',
        siteName: 'Stranger KB',
      };
      discoveryHolder.current = { state: { kind: 'managed', kbs: [stranger] }, kbs: [stranger] };

      render(<KnowledgeBasePanel />);

      expect(screen.queryByText(/another copy of the knowledge base/i)).not.toBeInTheDocument();
    });
  });

  describe('Conflict + verification (P3c — decisions 6 & 7)', () => {
    const claimantA = {
      host: 'localhost', port: 4000, placement: 'local' as const,
      managedBy: 'semiont-launcher', did: 'did:web:caselaw.example',
      siteName: 'Caselaw Knowledge Base', repo: 'org/caselaw',
    };
    const claimantB = {
      host: 'localhost', port: 4000, placement: 'codespace' as const,
      managedBy: 'semiont-launcher', did: 'did:web:synthetic.example',
      siteName: 'Synthetic Family', repo: 'pingel-org/synthetic-family',
    };

    beforeEach(() => {
      discoveryHolder.current = { state: null, kbs: [] };
    });

    it('names the conflict when two knowledge bases claim one address', () => {
      discoveryHolder.current = { state: { kind: 'managed', kbs: [claimantA, claimantB] }, kbs: [claimantA, claimantB] };
      render(<KnowledgeBasePanel />);

      expect(screen.getByText(/2 knowledge bases claim localhost:4000 — one is likely stale/i)).toBeInTheDocument();
    });

    it('keys contested claimants distinctly — the PAIR identifies an entry', () => {
      // Copilot review, PR #1108: P3b keyed rows on the address to stop twins
      // colliding, which traded one collision for the other — two claimants at
      // ONE address (kept visible on purpose) then shared a key, letting React
      // reuse DOM nodes across rows. Decision 9's table already said it:
      // neither field alone identifies an entry, the pair does.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      discoveryHolder.current = { state: { kind: 'managed', kbs: [claimantA, claimantB] }, kbs: [claimantA, claimantB] };

      render(<KnowledgeBasePanel />);

      expect(errorSpy.mock.calls.flat().join(' ')).not.toMatch(/same key/i);
      // Both claimants keep their own identity in their own row.
      expect(screen.getByText('Caselaw Knowledge Base')).toBeInTheDocument();
      expect(screen.getByText('Synthetic Family')).toBeInTheDocument();
      errorSpy.mockRestore();
    });

    it('does not cry conflict for a single claimant', () => {
      discoveryHolder.current = { state: { kind: 'managed', kbs: [claimantA] }, kbs: [claimantA] };
      render(<KnowledgeBasePanel />);

      expect(screen.queryByText(/likely stale/i)).not.toBeInTheDocument();
    });

    it('opens an ADDRESS-labelled form from an ambiguous row — no KB name implied (D)', async () => {
      discoveryHolder.current = { state: { kind: 'managed', kbs: [claimantA, claimantB] }, kbs: [claimantA, claimantB] };
      const user = userEvent.setup();
      render(<KnowledgeBasePanel />);

      await user.click(screen.getByText('Synthetic Family'));

      // The form announces the ADDRESS it will connect to — the click was
      // always an address, and at most one claimant's promise is true.
      expect(screen.getByText('Connect to localhost:4000')).toBeInTheDocument();
      expect(screen.queryByText('Connect to Knowledge Base')).not.toBeInTheDocument();
    });

    it('records what the user believed they clicked, so the return can verify it (C)', async () => {
      discoveryHolder.current = { state: { kind: 'managed', kbs: [claimantA, claimantB] }, kbs: [claimantA, claimantB] };
      const user = userEvent.setup();
      render(<KnowledgeBasePanel />);

      await user.click(screen.getByText('Synthetic Family'));
      await user.click(screen.getByRole('button', { name: 'Connect' }));

      await waitFor(() => expect(assign).toHaveBeenCalled());
      // Recording the belief is not promising it: the browser verifies the
      // KB that answers against this on the way back, and reports.
      expect(mockBrowser.beginSignIn).toHaveBeenCalledWith(expect.objectContaining({
        target: { kind: 'http', host: 'localhost', port: 4000, protocol: 'http' },
        expectedDid: 'did:web:synthetic.example',
        expectedName: 'Synthetic Family',
      }));
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
      repo: 'org/prod-kb',
    };

    beforeEach(() => {
      discoveryHolder.current = { state: null, kbs: [] };
    });

    it('renders launcher-discovered KBs in their own section (fixed shape, repo slot)', () => {
      discoveryHolder.current = { state: { kind: 'managed', kbs: [discoveredLocal] }, kbs: [discoveredLocal] };
      render(<KnowledgeBasePanel />);

      expect(screen.getByText('Found on this machine')).toBeInTheDocument();
      expect(screen.getByText('Local KB')).toBeInTheDocument();
      // Fixed shape, stacked (2026-07-21: vertical space over width): the
      // endpoint and the repo slot are separate lines; no repo → '–' line.
      expect(screen.getByText('localhost:4001')).toBeInTheDocument();
      expect(screen.getByText('–')).toBeInTheDocument();
      expect(screen.getByText('local')).toBeInTheDocument();
      // The did is inspectable as the row tooltip.
      expect(screen.getByTitle('did:web:local.example')).toBeInTheDocument();
    });

    it('renders a placeholder name for a discovered KB without a siteName — never a duplicated line', () => {
      const nameless = { host: 'localhost', port: 4002, placement: 'local' as const, managedBy: 'semiont-launcher', did: 'did:web:nameless.example', repo: 'org/other-kb' };
      discoveryHolder.current = { state: { kind: 'managed', kbs: [nameless] }, kbs: [nameless] };
      render(<KnowledgeBasePanel />);

      expect(screen.getByText('–')).toBeInTheDocument();
      expect(screen.getByText('localhost:4002')).toBeInTheDocument();
      expect(screen.getByText('org/other-kb')).toBeInTheDocument();
      // The endpoint appears once, as its own line — not as the name too.
      expect(screen.getAllByText(/localhost:4002/)).toHaveLength(1);
    });

    it('clicking a discovered KB opens the connect form prefilled with its endpoint', async () => {
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
      // The adopted row borrows discovery's repo, on its own stacked line
      // (render-only; endpoint · branch stays a short first line).
      expect(screen.getByText('prod.example.com:4000 · main')).toBeInTheDocument();
      expect(screen.getByText('org/prod-kb')).toBeInTheDocument();
    });

    it('claims no identity when two discovered KBs share an endpoint (ambiguous join)', () => {
      // Observed live: the launcher published a stale codespace forward AND a
      // freshly started local stack both claiming localhost:4000. Only one
      // process can bind a port, so one is stale — but the panel joins on
      // host:port (registered KBs carry no did), so a last-wins map tagged the
      // connected KB with the OTHER KB's repo and placement. Ambiguous ⇒ don't
      // guess: no badge, and both entries stay visible so the stale launcher
      // record is surfaced instead of silently swallowed.
      const dupLocal = {
        host: 'prod.example.com', port: 4000, placement: 'local' as const,
        managedBy: 'semiont-launcher', did: 'did:web:real', repo: 'org/real-kb',
      };
      const dupStale = {
        host: 'prod.example.com', port: 4000, placement: 'codespace' as const,
        managedBy: 'semiont-launcher', did: 'did:web:stale', repo: 'org/stale-kb',
      };
      discoveryHolder.current = {
        state: { kind: 'managed', kbs: [dupLocal, dupStale] },
        kbs: [dupLocal, dupStale],
      };
      render(<KnowledgeBasePanel />);

      // The registered row (kb1 lives at prod.example.com:4000) borrows nothing
      // from either claimant — no badge, and neither repo bleeds into its line.
      const registeredRow = screen.getByText('Production').closest('.semiont-panel-item') as HTMLElement;
      expect(within(registeredRow).queryByTitle('Managed by launcher')).not.toBeInTheDocument();
      expect(within(registeredRow).queryByText(/org\/(real|stale)-kb/)).not.toBeInTheDocument();

      // Both ambiguous entries remain listed for the user to sort out.
      expect(screen.getByText('Found on this machine')).toBeInTheDocument();
      expect(screen.getByText('org/real-kb')).toBeInTheDocument();
      expect(screen.getByText('org/stale-kb')).toBeInTheDocument();
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

  describe('switching KB away from a resource route', () => {
    // The route carries the PREVIOUS KB's resource id, which means nothing to
    // the KB being switched to — asking for it earns a 404 and the B14/B15
    // retry-then-fail chain. The panel is where the switch is initiated, so it
    // is the only place that knows a switch is happening BEFORE the layout
    // tears the resource page down.
    // See .plans/bugs/resource-page-frozen-on-disposed-client-after-kb-switch.md

    beforeEach(() => {
      pathHolder.current = '/know/resource/res-from-kb-1';
    });

    it('navigates to /know so the new KB resolves its own last-viewed resource', async () => {
      kbs$.next([kb1, kb2]);
      render(<KnowledgeBasePanel />);

      await userEvent.click(screen.getByText('Production'));

      expect(mockEmit).toHaveBeenCalledWith('nav:push', expect.objectContaining({ path: '/know' }));
    });

    it('stays put when the current route carries no resource id', async () => {
      pathHolder.current = '/know/discover';
      kbs$.next([kb1, kb2]);
      render(<KnowledgeBasePanel />);

      await userEvent.click(screen.getByText('Production'));

      expect(mockEmit).not.toHaveBeenCalled();
    });
  });
});
