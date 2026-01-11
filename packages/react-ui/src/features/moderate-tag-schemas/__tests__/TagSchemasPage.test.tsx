/**
 * Tests for TagSchemasPage component
 *
 * Tests the moderation tag schemas viewing page.
 * No Next.js mocking required - all dependencies passed as props!
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TagSchemasPage } from '../components/TagSchemasPage';
import type { TagSchemasPageProps, TagSchema } from '../components/TagSchemasPage';

const mockSchemas: TagSchema[] = [
  {
    id: 'legal-irac',
    name: 'Legal Analysis (IRAC)',
    description: 'Issue, Rule, Application, Conclusion framework',
    domain: 'legal',
    tags: [
      {
        name: 'Issue',
        description: 'The legal question',
        examples: ['What is the central legal question?', 'What must the court decide?', 'What is the dispute?']
      },
      {
        name: 'Rule',
        description: 'The relevant law',
        examples: ['What law applies?', 'What is the legal standard?']
      }
    ]
  },
  {
    id: 'scientific-imrad',
    name: 'Scientific Paper (IMRAD)',
    description: 'Introduction, Methods, Results, Discussion structure',
    domain: 'scientific',
    tags: [
      {
        name: 'Introduction',
        description: 'Background and context',
        examples: ['What is the research question?', 'Why is this important?']
      }
    ]
  },
  {
    id: 'argument-toulmin',
    name: 'Argument Structure (Toulmin)',
    description: 'Claim, Evidence, Warrant framework',
    domain: 'general',
    tags: [
      {
        name: 'Claim',
        description: 'The main assertion',
        examples: ['What is being argued?']
      }
    ]
  }
];

const createMockProps = (overrides?: Partial<TagSchemasPageProps>): TagSchemasPageProps => ({
  schemas: mockSchemas,
  isLoading: false,
  theme: 'light',
  onThemeChange: vi.fn(),
  showLineNumbers: false,
  onLineNumbersToggle: vi.fn(),
  activePanel: null,
  onPanelToggle: vi.fn(),
  translations: {
    pageTitle: 'Tag Schemas',
    pageDescription: 'View available tag schemas for content analysis',
    categories: 'Categories',
    loading: 'Loading...',
  },
  ToolbarPanels: () => <div data-testid="toolbar-panels" />,
  Toolbar: () => <div data-testid="toolbar" />,
  ...overrides,
});

describe('TagSchemasPage', () => {
  describe('Basic Rendering', () => {
    it('renders page title and description', () => {
      const props = createMockProps();
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('Tag Schemas')).toBeInTheDocument();
      expect(screen.getByText('View available tag schemas for content analysis')).toBeInTheDocument();
    });

    it('renders loading state', () => {
      const props = createMockProps({ isLoading: true });
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('Loading...')).toBeInTheDocument();
      expect(screen.queryByText('Tag Schemas')).not.toBeInTheDocument();
    });

    it('does not render schemas when loading', () => {
      const props = createMockProps({ isLoading: true });
      render(<TagSchemasPage {...props} />);

      expect(screen.queryByText('Legal Analysis (IRAC)')).not.toBeInTheDocument();
    });
  });

  describe('Schema Display', () => {
    it('displays all schemas', () => {
      const props = createMockProps();
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('Legal Analysis (IRAC)')).toBeInTheDocument();
      expect(screen.getByText('Scientific Paper (IMRAD)')).toBeInTheDocument();
      expect(screen.getByText('Argument Structure (Toulmin)')).toBeInTheDocument();
    });

    it('displays schema descriptions', () => {
      const props = createMockProps();
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('Issue, Rule, Application, Conclusion framework')).toBeInTheDocument();
      expect(screen.getByText('Introduction, Methods, Results, Discussion structure')).toBeInTheDocument();
      expect(screen.getByText('Claim, Evidence, Warrant framework')).toBeInTheDocument();
    });

    it('displays domain badges', () => {
      const props = createMockProps();
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('legal')).toBeInTheDocument();
      expect(screen.getByText('scientific')).toBeInTheDocument();
      expect(screen.getByText('general')).toBeInTheDocument();
    });

    it('handles empty schemas array', () => {
      const props = createMockProps({ schemas: [] });
      const { container } = render(<TagSchemasPage {...props} />);

      const schemaCards = container.querySelectorAll('.bg-white.dark\\:bg-gray-800');
      expect(schemaCards.length).toBe(0);
    });

    it('handles single schema', () => {
      const schema = mockSchemas[0];
      if (!schema) throw new Error('Schema not found');
      const props = createMockProps({ schemas: [schema] });
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('Legal Analysis (IRAC)')).toBeInTheDocument();
      expect(screen.queryByText('Scientific Paper (IMRAD)')).not.toBeInTheDocument();
    });
  });

  describe('Domain Icons and Colors', () => {
    it('renders legal domain with purple styling', () => {
      const props = createMockProps();
      const { container } = render(<TagSchemasPage {...props} />);

      const purpleIcon = container.querySelector('.bg-purple-100');
      expect(purpleIcon).toBeInTheDocument();
    });

    it('renders scientific domain with green styling', () => {
      const props = createMockProps();
      const { container } = render(<TagSchemasPage {...props} />);

      const greenIcon = container.querySelector('.bg-green-100');
      expect(greenIcon).toBeInTheDocument();
    });

    it('renders general domain with orange styling', () => {
      const props = createMockProps();
      const { container } = render(<TagSchemasPage {...props} />);

      const orangeIcon = container.querySelector('.bg-orange-100');
      expect(orangeIcon).toBeInTheDocument();
    });

    it('applies correct domain colors to badges', () => {
      const props = createMockProps();
      const { container } = render(<TagSchemasPage {...props} />);

      const legalBadge = container.querySelector('.border-purple-200');
      const scientificBadge = container.querySelector('.border-green-200');
      const generalBadge = container.querySelector('.border-orange-200');

      expect(legalBadge).toBeInTheDocument();
      expect(scientificBadge).toBeInTheDocument();
      expect(generalBadge).toBeInTheDocument();
    });
  });

  describe('Tag Categories', () => {
    it('displays categories heading', () => {
      const props = createMockProps();
      render(<TagSchemasPage {...props} />);

      const categoriesHeadings = screen.getAllByText('Categories');
      expect(categoriesHeadings.length).toBeGreaterThan(0);
    });

    it('displays category names', () => {
      const props = createMockProps();
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('Issue')).toBeInTheDocument();
      expect(screen.getByText('Rule')).toBeInTheDocument();
      expect(screen.getByText('Introduction')).toBeInTheDocument();
      expect(screen.getByText('Claim')).toBeInTheDocument();
    });

    it('displays category descriptions', () => {
      const props = createMockProps();
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('The legal question')).toBeInTheDocument();
      expect(screen.getByText('The relevant law')).toBeInTheDocument();
      expect(screen.getByText('Background and context')).toBeInTheDocument();
    });

    it('displays first two examples', () => {
      const props = createMockProps();
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('What is the central legal question?')).toBeInTheDocument();
      expect(screen.getByText('What must the court decide?')).toBeInTheDocument();
    });

    it('shows "+N more" when more than 2 examples', () => {
      const props = createMockProps();
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('+1 more')).toBeInTheDocument();
    });

    it('does not show "+N more" when 2 or fewer examples', () => {
      const props = createMockProps();
      render(<TagSchemasPage {...props} />);

      const ruleSection = screen.getByText('Rule').closest('.bg-gray-50');
      expect(ruleSection).toBeInTheDocument();
      expect(ruleSection?.textContent).not.toContain('more');
    });
  });

  describe('Toolbar Integration', () => {
    it('renders toolbar panels', () => {
      const props = createMockProps();
      render(<TagSchemasPage {...props} />);

      expect(screen.getByTestId('toolbar-panels')).toBeInTheDocument();
    });

    it('renders toolbar', () => {
      const props = createMockProps();
      render(<TagSchemasPage {...props} />);

      expect(screen.getByTestId('toolbar')).toBeInTheDocument();
    });

    it('passes theme to toolbar panels', () => {
      const ToolbarPanels = vi.fn(() => <div data-testid="toolbar-panels" />);
      const props = createMockProps({ theme: 'dark', ToolbarPanels });
      render(<TagSchemasPage {...props} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'dark' }),
        expect.anything()
      );
    });

    it('passes activePanel to toolbar', () => {
      const Toolbar = vi.fn(() => <div data-testid="toolbar" />);
      const props = createMockProps({ activePanel: 'settings', Toolbar });
      render(<TagSchemasPage {...props} />);

      expect(Toolbar).toHaveBeenCalledWith(
        expect.objectContaining({ activePanel: 'settings' }),
        expect.anything()
      );
    });

    it('passes showLineNumbers to toolbar panels', () => {
      const ToolbarPanels = vi.fn(() => <div data-testid="toolbar-panels" />);
      const props = createMockProps({ showLineNumbers: true, ToolbarPanels });
      render(<TagSchemasPage {...props} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({ showLineNumbers: true }),
        expect.anything()
      );
    });

    it('passes callbacks to toolbar components', () => {
      const onThemeChange = vi.fn();
      const onLineNumbersToggle = vi.fn();
      const onPanelToggle = vi.fn();
      const ToolbarPanels = vi.fn(() => <div data-testid="toolbar-panels" />);
      const Toolbar = vi.fn(() => <div data-testid="toolbar" />);

      const props = createMockProps({
        onThemeChange,
        onLineNumbersToggle,
        onPanelToggle,
        ToolbarPanels,
        Toolbar,
      });
      render(<TagSchemasPage {...props} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({
          onThemeChange,
          onLineNumbersToggle,
        }),
        expect.anything()
      );

      expect(Toolbar).toHaveBeenCalledWith(
        expect.objectContaining({ onPanelToggle }),
        expect.anything()
      );
    });
  });

  describe('Layout and Structure', () => {
    it('renders with correct flex layout', () => {
      const props = createMockProps();
      const { container } = render(<TagSchemasPage {...props} />);

      const mainContainer = container.querySelector('.flex.flex-1');
      expect(mainContainer).toBeInTheDocument();
    });

    it('renders content area with overflow', () => {
      const props = createMockProps();
      const { container } = render(<TagSchemasPage {...props} />);

      const scrollArea = container.querySelector('.overflow-y-auto');
      expect(scrollArea).toBeInTheDocument();
    });

    it('uses grid layout for schemas', () => {
      const props = createMockProps();
      const { container } = render(<TagSchemasPage {...props} />);

      const grid = container.querySelector('.grid.grid-cols-1.lg\\:grid-cols-2');
      expect(grid).toBeInTheDocument();
    });

    it('applies correct padding to content', () => {
      const props = createMockProps();
      const { container } = render(<TagSchemasPage {...props} />);

      const contentArea = container.querySelector('.px-4.py-8');
      expect(contentArea).toBeInTheDocument();
    });
  });

  describe('Dark Mode', () => {
    it('renders with dark theme', () => {
      const props = createMockProps({ theme: 'dark' });
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('Tag Schemas')).toBeInTheDocument();
    });

    it('applies dark mode classes to schema cards', () => {
      const props = createMockProps({ theme: 'dark' });
      const { container } = render(<TagSchemasPage {...props} />);

      const card = container.querySelector('.dark\\:bg-gray-800');
      expect(card).toBeInTheDocument();
    });

    it('applies dark mode classes to category containers', () => {
      const props = createMockProps({ theme: 'dark' });
      const { container } = render(<TagSchemasPage {...props} />);

      const categoryContainer = container.querySelector('.dark\\:bg-gray-900\\/50');
      expect(categoryContainer).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('handles schema with no tags', () => {
      const emptySchema: TagSchema = {
        id: 'empty',
        name: 'Empty Schema',
        description: 'A schema with no tags',
        domain: 'general',
        tags: []
      };
      const props = createMockProps({ schemas: [emptySchema] });
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('Empty Schema')).toBeInTheDocument();
    });

    it('handles tag with no examples', () => {
      const schemaWithNoExamples: TagSchema = {
        id: 'no-examples',
        name: 'Schema',
        description: 'Schema',
        domain: 'general',
        tags: [{
          name: 'Tag',
          description: 'Description',
          examples: []
        }]
      };
      const props = createMockProps({ schemas: [schemaWithNoExamples] });
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('Tag')).toBeInTheDocument();
    });

    it('handles tag with one example', () => {
      const schemaWithOneExample: TagSchema = {
        id: 'one-example',
        name: 'Schema',
        description: 'Schema',
        domain: 'general',
        tags: [{
          name: 'Tag',
          description: 'Description',
          examples: ['Only example']
        }]
      };
      const props = createMockProps({ schemas: [schemaWithOneExample] });
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('Only example')).toBeInTheDocument();
    });

    it('renders with custom translations', () => {
      const props = createMockProps({
        translations: {
          pageTitle: 'Custom Title',
          pageDescription: 'Custom Description',
          categories: 'Custom Categories',
          loading: 'Custom Loading',
        },
      });
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('Custom Title')).toBeInTheDocument();
      expect(screen.getByText('Custom Description')).toBeInTheDocument();
      expect(screen.getAllByText('Custom Categories').length).toBeGreaterThan(0);
    });

    it('handles all props being defined', () => {
      const props = createMockProps({
        theme: 'dark',
        showLineNumbers: true,
        activePanel: 'settings',
      });
      render(<TagSchemasPage {...props} />);

      expect(screen.getByText('Tag Schemas')).toBeInTheDocument();
    });
  });
});
