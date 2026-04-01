import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KnowledgeBasePanel } from '../KnowledgeBasePanel';

const mockPush = vi.fn();
const mockSetActiveKnowledgeBase = vi.fn();

const kb1 = { id: 'kb-1', label: 'Production', backendUrl: 'https://prod.example.com' };
const kb2 = { id: 'kb-2', label: 'Staging', backendUrl: 'http://staging.example.com' };

let mockKnowledgeBases = [kb1, kb2];
let mockActiveKnowledgeBase: typeof kb1 | null = kb1;

vi.mock('@/i18n/routing', () => ({
  useRouter: () => ({ push: mockPush }),
}));

vi.mock('@/contexts/KnowledgeBaseContext', () => ({
  useKnowledgeBaseContext: () => ({
    get knowledgeBases() { return mockKnowledgeBases; },
    get activeKnowledgeBase() { return mockActiveKnowledgeBase; },
    setActiveKnowledgeBase: mockSetActiveKnowledgeBase,
  }),
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

    it('should display backend URLs with protocol stripped', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByText('prod.example.com')).toBeInTheDocument();
      expect(screen.getByText('staging.example.com')).toBeInTheDocument();
    });

    it('should render the Add knowledge base button', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByText('Add knowledge base')).toBeInTheDocument();
    });

    it('should render without errors when no knowledge bases are configured', () => {
      mockKnowledgeBases = [];
      mockActiveKnowledgeBase = null;
      render(<KnowledgeBasePanel />);
      expect(screen.getByRole('heading', { name: /Knowledge Bases/ })).toBeInTheDocument();
      expect(screen.getByText('Add knowledge base')).toBeInTheDocument();
    });
  });

  describe('Active knowledge base indicator', () => {
    it('should show a checkmark only on the active knowledge base', () => {
      render(<KnowledgeBasePanel />);
      const buttons = screen.getAllByRole('button').filter(b =>
        b.textContent?.includes('Production') || b.textContent?.includes('Staging')
      );
      const kb1Button = buttons.find(b => b.textContent?.includes('Production'))!;
      const kb2Button = buttons.find(b => b.textContent?.includes('Staging'))!;

      // kb1 is active — should have a checkmark svg
      expect(kb1Button.querySelector('svg')).toBeInTheDocument();
      // kb2 is not active — should have no checkmark
      expect(kb2Button.querySelector('svg')).not.toBeInTheDocument();
    });

    it('should show no checkmark when no knowledge base is active', () => {
      mockActiveKnowledgeBase = null;
      render(<KnowledgeBasePanel />);
      const kbButtons = screen.getAllByRole('button').filter(b =>
        b.textContent?.includes('Production') || b.textContent?.includes('Staging')
      );
      kbButtons.forEach(b => expect(b.querySelector('svg')).not.toBeInTheDocument());
    });
  });

  describe('Switching knowledge bases', () => {
    it('should call setActiveKnowledgeBase with the kb id when clicked', async () => {
      const user = userEvent.setup();
      render(<KnowledgeBasePanel />);

      await user.click(screen.getByText('Staging'));

      expect(mockSetActiveKnowledgeBase).toHaveBeenCalledWith('kb-2');
      expect(mockSetActiveKnowledgeBase).toHaveBeenCalledTimes(1);
    });

    it('should call setActiveKnowledgeBase when the currently active kb is clicked', async () => {
      const user = userEvent.setup();
      render(<KnowledgeBasePanel />);

      await user.click(screen.getByText('Production'));

      expect(mockSetActiveKnowledgeBase).toHaveBeenCalledWith('kb-1');
    });
  });

  describe('Add knowledge base', () => {
    it('should navigate to /auth/connect when clicked', async () => {
      const user = userEvent.setup();
      render(<KnowledgeBasePanel />);

      await user.click(screen.getByText('Add knowledge base'));

      expect(mockPush).toHaveBeenCalledWith('/auth/connect');
      expect(mockPush).toHaveBeenCalledTimes(1);
    });
  });

  describe('URL display', () => {
    it('should strip https:// from backend URLs', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByText('prod.example.com')).toBeInTheDocument();
      expect(screen.queryByText('https://prod.example.com')).not.toBeInTheDocument();
    });

    it('should strip http:// from backend URLs', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByText('staging.example.com')).toBeInTheDocument();
      expect(screen.queryByText('http://staging.example.com')).not.toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should render each knowledge base and the add action as buttons', () => {
      render(<KnowledgeBasePanel />);
      // kb1 + kb2 + "Add knowledge base"
      expect(screen.getAllByRole('button')).toHaveLength(3);
    });

    it('should have a heading for the panel', () => {
      render(<KnowledgeBasePanel />);
      expect(screen.getByRole('heading')).toBeInTheDocument();
    });
  });
});
