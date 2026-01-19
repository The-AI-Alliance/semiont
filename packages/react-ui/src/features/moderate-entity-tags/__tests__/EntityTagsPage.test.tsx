/**
 * Tests for EntityTagsPage component
 *
 * Tests the moderation entity tags management page.
 * No Next.js mocking required - all dependencies passed as props!
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EntityTagsPage } from '../components/EntityTagsPage';
import type { EntityTagsPageProps } from '../components/EntityTagsPage';

const createMockProps = (overrides?: Partial<EntityTagsPageProps>): EntityTagsPageProps => ({
  entityTypes: ['Document', 'Person', 'Organization'],
  isLoading: false,
  error: '',
  newTag: '',
  onNewTagChange: vi.fn(),
  onAddTag: vi.fn(),
  isAddingTag: false,
  theme: 'light',
  onThemeChange: vi.fn(),
  showLineNumbers: false,
  onLineNumbersToggle: vi.fn(),
  activePanel: null,
  onPanelToggle: vi.fn(),
  translations: {
    pageTitle: 'Entity Tags',
    pageDescription: 'Manage entity type tags',
    sectionTitle: 'Available Tags',
    sectionDescription: 'Tags for categorizing entities',
    inputPlaceholder: 'Enter new tag',
    addTag: 'Add Tag',
    adding: 'Adding...',
  },
  ToolbarPanels: () => <div data-testid="toolbar-panels" />,
  Toolbar: () => <div data-testid="toolbar" />,
  ...overrides,
});

describe('EntityTagsPage', () => {
  describe('Basic Rendering', () => {
    it('renders page title and description', () => {
      const props = createMockProps();
      render(<EntityTagsPage {...props} />);

      expect(screen.getByText('Entity Tags')).toBeInTheDocument();
      expect(screen.getByText('Manage entity type tags')).toBeInTheDocument();
    });

    it('renders section title and description', () => {
      const props = createMockProps();
      render(<EntityTagsPage {...props} />);

      expect(screen.getByText('Available Tags')).toBeInTheDocument();
      expect(screen.getByText('Tags for categorizing entities')).toBeInTheDocument();
    });

    it('renders tag icon', () => {
      const props = createMockProps();
      const { container } = render(<EntityTagsPage {...props} />);

      const icon = container.querySelector('.semiont-entity-tags__icon');
      expect(icon).toBeInTheDocument();
    });
  });

  describe('Entity Tags Display', () => {
    it('displays all entity tags', () => {
      const props = createMockProps();
      render(<EntityTagsPage {...props} />);

      expect(screen.getByText('Document')).toBeInTheDocument();
      expect(screen.getByText('Person')).toBeInTheDocument();
      expect(screen.getByText('Organization')).toBeInTheDocument();
    });

    it('renders tags with correct styling', () => {
      const props = createMockProps();
      const { container } = render(<EntityTagsPage {...props} />);

      const tagBadge = container.querySelector('.semiont-tag');
      expect(tagBadge).toBeInTheDocument();
      expect(tagBadge).toHaveTextContent('Document');
    });

    it('handles empty entity types', () => {
      const props = createMockProps({ entityTypes: [] });
      const { container } = render(<EntityTagsPage {...props} />);

      const tags = container.querySelectorAll('.semiont-tag');
      expect(tags.length).toBe(0);
    });

    it('handles many entity types', () => {
      const manyTags = Array.from({ length: 20 }, (_, i) => `Tag${i}`);
      const props = createMockProps({ entityTypes: manyTags });
      render(<EntityTagsPage {...props} />);

      expect(screen.getByText('Tag0')).toBeInTheDocument();
      expect(screen.getByText('Tag19')).toBeInTheDocument();
    });
  });

  describe('Add Tag Input', () => {
    it('renders input with placeholder', () => {
      const props = createMockProps();
      render(<EntityTagsPage {...props} />);

      expect(screen.getByPlaceholderText('Enter new tag')).toBeInTheDocument();
    });

    it('calls onNewTagChange when typing', () => {
      const onNewTagChange = vi.fn();
      const props = createMockProps({ onNewTagChange });
      render(<EntityTagsPage {...props} />);

      const input = screen.getByPlaceholderText('Enter new tag');
      fireEvent.change(input, { target: { value: 'NewTag' } });

      expect(onNewTagChange).toHaveBeenCalledWith('NewTag');
    });

    it('displays current newTag value', () => {
      const props = createMockProps({ newTag: 'Current Value' });
      render(<EntityTagsPage {...props} />);

      const input = screen.getByPlaceholderText('Enter new tag') as HTMLInputElement;
      expect(input.value).toBe('Current Value');
    });

    it('disables input when adding tag', () => {
      const props = createMockProps({ isAddingTag: true });
      render(<EntityTagsPage {...props} />);

      const input = screen.getByPlaceholderText('Enter new tag');
      expect(input).toBeDisabled();
    });

    it('calls onAddTag when Enter key pressed', () => {
      const onAddTag = vi.fn();
      const props = createMockProps({ onAddTag, newTag: 'Test' });
      render(<EntityTagsPage {...props} />);

      const input = screen.getByPlaceholderText('Enter new tag');
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onAddTag).toHaveBeenCalledTimes(1);
    });

    it('does not call onAddTag for other keys', () => {
      const onAddTag = vi.fn();
      const props = createMockProps({ onAddTag });
      render(<EntityTagsPage {...props} />);

      const input = screen.getByPlaceholderText('Enter new tag');
      fireEvent.keyDown(input, { key: 'a' });
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(onAddTag).not.toHaveBeenCalled();
    });
  });

  describe('Add Tag Button', () => {
    it('renders add tag button', () => {
      const props = createMockProps();
      render(<EntityTagsPage {...props} />);

      expect(screen.getByRole('button', { name: /Add Tag/i })).toBeInTheDocument();
    });

    it('calls onAddTag when clicked', () => {
      const onAddTag = vi.fn();
      const props = createMockProps({ onAddTag, newTag: 'Test' });
      render(<EntityTagsPage {...props} />);

      fireEvent.click(screen.getByRole('button', { name: /Add Tag/i }));
      expect(onAddTag).toHaveBeenCalledTimes(1);
    });

    it('disables button when adding', () => {
      const props = createMockProps({ isAddingTag: true });
      render(<EntityTagsPage {...props} />);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });

    it('disables button when newTag is empty', () => {
      const props = createMockProps({ newTag: '' });
      render(<EntityTagsPage {...props} />);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });

    it('disables button when newTag is whitespace only', () => {
      const props = createMockProps({ newTag: '   ' });
      render(<EntityTagsPage {...props} />);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
    });

    it('enables button when newTag has value', () => {
      const props = createMockProps({ newTag: 'NewTag' });
      render(<EntityTagsPage {...props} />);

      const button = screen.getByRole('button');
      expect(button).not.toBeDisabled();
    });

    it('shows adding text when isAddingTag is true', () => {
      const props = createMockProps({ isAddingTag: true });
      render(<EntityTagsPage {...props} />);

      expect(screen.getByText('Adding...')).toBeInTheDocument();
    });

    it('shows add tag icon when not adding', () => {
      const props = createMockProps();
      const { container } = render(<EntityTagsPage {...props} />);

      const plusIcon = container.querySelector('.semiont-icon--small');
      expect(plusIcon).toBeInTheDocument();
    });
  });

  describe('Error Display', () => {
    it('shows error message when error prop is set', () => {
      const props = createMockProps({ error: 'Failed to add tag' });
      render(<EntityTagsPage {...props} />);

      expect(screen.getByText('Failed to add tag')).toBeInTheDocument();
    });

    it('shows error icon with error message', () => {
      const props = createMockProps({ error: 'Error occurred' });
      const { container } = render(<EntityTagsPage {...props} />);

      const errorIcon = container.querySelector('.semiont-entity-tags__error-icon');
      expect(errorIcon).toBeInTheDocument();
    });

    it('does not show error when error is empty', () => {
      const props = createMockProps({ error: '' });
      const { container } = render(<EntityTagsPage {...props} />);

      const errorMessage = container.querySelector('.semiont-entity-tags__error');
      expect(errorMessage).not.toBeInTheDocument();
    });

    it('applies correct error styling', () => {
      const props = createMockProps({ error: 'Test error' });
      const { container } = render(<EntityTagsPage {...props} />);

      const errorDiv = container.querySelector('.semiont-entity-tags__error');
      expect(errorDiv).toBeInTheDocument();
    });
  });

  describe('Toolbar Integration', () => {
    it('renders toolbar panels', () => {
      const props = createMockProps();
      render(<EntityTagsPage {...props} />);

      expect(screen.getByTestId('toolbar-panels')).toBeInTheDocument();
    });

    it('renders toolbar', () => {
      const props = createMockProps();
      render(<EntityTagsPage {...props} />);

      expect(screen.getByTestId('toolbar')).toBeInTheDocument();
    });

    it('passes theme to toolbar panels', () => {
      const ToolbarPanels = vi.fn(() => <div data-testid="toolbar-panels" />);
      const props = createMockProps({ theme: 'dark', ToolbarPanels });
      render(<EntityTagsPage {...props} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({ theme: 'dark' }),
        expect.anything()
      );
    });

    it('passes activePanel to toolbar', () => {
      const Toolbar = vi.fn(() => <div data-testid="toolbar" />);
      const props = createMockProps({ activePanel: 'settings', Toolbar });
      render(<EntityTagsPage {...props} />);

      expect(Toolbar).toHaveBeenCalledWith(
        expect.objectContaining({ activePanel: 'settings' }),
        expect.anything()
      );
    });
  });

  describe('Layout and Structure', () => {
    it('renders with correct flex layout', () => {
      const props = createMockProps();
      const { container } = render(<EntityTagsPage {...props} />);

      const mainContainer = container.querySelector('.semiont-page');
      expect(mainContainer).toBeInTheDocument();
    });

    it('renders content area with overflow', () => {
      const props = createMockProps();
      const { container } = render(<EntityTagsPage {...props} />);

      const scrollArea = container.querySelector('.semiont-page__content');
      expect(scrollArea).toBeInTheDocument();
    });

    it('applies correct padding to content', () => {
      const props = createMockProps();
      const { container } = render(<EntityTagsPage {...props} />);

      const contentArea = container.querySelector('.semiont-page__content');
      expect(contentArea).toBeInTheDocument();
    });
  });

  describe('Dark Mode', () => {
    it('renders with dark theme', () => {
      const props = createMockProps({ theme: 'dark' });
      render(<EntityTagsPage {...props} />);

      expect(screen.getByText('Entity Tags')).toBeInTheDocument();
    });

    it('applies dark mode classes to input', () => {
      const props = createMockProps({ theme: 'dark' });
      const { container } = render(<EntityTagsPage {...props} />);

      const input = container.querySelector('input');
      expect(input).toHaveClass('semiont-entity-tags__input');
    });
  });

  describe('Edge Cases', () => {
    it('handles all props being defined', () => {
      const props = createMockProps({
        newTag: 'Test',
        error: 'Error',
        isAddingTag: true,
        theme: 'dark',
        showLineNumbers: true,
        activePanel: 'settings',
      });
      render(<EntityTagsPage {...props} />);

      expect(screen.getByText('Entity Tags')).toBeInTheDocument();
    });

    it('renders with custom translations', () => {
      const props = createMockProps({
        translations: {
          pageTitle: 'Custom Title',
          pageDescription: 'Custom Description',
          sectionTitle: 'Custom Section',
          sectionDescription: 'Custom Section Desc',
          inputPlaceholder: 'Custom Placeholder',
          addTag: 'Custom Add',
          adding: 'Custom Adding',
        },
      });
      render(<EntityTagsPage {...props} />);

      expect(screen.getByText('Custom Title')).toBeInTheDocument();
      expect(screen.getByText('Custom Description')).toBeInTheDocument();
      expect(screen.getByText('Custom Section')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Custom Placeholder')).toBeInTheDocument();
    });
  });
});
