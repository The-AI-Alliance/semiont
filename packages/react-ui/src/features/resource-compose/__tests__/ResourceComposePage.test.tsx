/**
 * Tests for ResourceComposePage component
 *
 * Tests the main resource compose UI component.
 * No Next.js mocking required - all dependencies passed as props!
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ResourceComposePage } from '../components/ResourceComposePage';
import type { ResourceComposePageProps, SaveResourceParams } from '../components/ResourceComposePage';

// Mock dependencies
vi.mock('@semiont/react-ui', async () => {
  const actual = await vi.importActual('@semiont/react-ui');
  return {
    ...actual,
    buttonStyles: {
      primary: { base: 'btn-primary' },
      tertiary: { base: 'btn-tertiary' },
    },
    CodeMirrorRenderer: ({ content, onChange, editable }: any) => (
      <textarea
        data-testid="code-editor"
        value={content}
        onChange={(e) => editable && onChange?.(e.target.value)}
        disabled={!editable}
      />
    ),
  };
});

const createMockTranslations = () => ({
  title: 'Compose Resource',
  titleEditClone: 'Edit Cloned Resource',
  titleCompleteReference: 'Complete Reference',
  subtitleClone: 'Editing a cloned resource',
  subtitleReference: 'Creating a new resource for reference',
  linkedNoticePrefix: 'This resource will be linked',
  resourceName: 'Resource Name',
  resourceNamePlaceholder: 'Enter resource name',
  entityTypes: 'Entity Types',
  language: 'Language',
  contentSource: 'Content Source',
  uploadFile: 'Upload File',
  uploadFileDescription: 'Upload a file',
  writeContent: 'Write Content',
  writeContentDescription: 'Write content manually',
  dropFileOrClick: 'Drop file or click',
  supportedFormats: 'Supported: text, markdown, images',
  mediaType: 'Media Type',
  autoDetected: 'Auto-detected',
  format: 'Format',
  content: 'Content',
  resourceContent: 'Resource Content',
  encoding: 'Encoding',
  archiveOriginal: 'Archive original resource',
  cancel: 'Cancel',
  saving: 'Saving...',
  creating: 'Creating...',
  creatingAndLinking: 'Creating and linking...',
  saveClonedResource: 'Save Cloned Resource',
  createAndLinkResource: 'Create and Link Resource',
  createResource: 'Create Resource',
});

const createMockProps = (overrides?: Partial<ResourceComposePageProps>): ResourceComposePageProps => ({
  mode: 'new',
  availableEntityTypes: ['Document', 'Article', 'Report'],
  initialLocale: 'en',
  theme: 'light',
  onThemeChange: vi.fn(),
  showLineNumbers: false,
  onLineNumbersToggle: vi.fn(),
  activePanel: null,
  onPanelToggle: vi.fn(),
  onSaveResource: vi.fn().mockResolvedValue(undefined),
  onCancel: vi.fn(),
  translations: createMockTranslations(),
  ToolbarPanels: ({ children }: any) => <div data-testid="toolbar-panels">{children}</div>,
  Toolbar: () => <div data-testid="toolbar">Toolbar</div>,
  ...overrides,
});

describe('ResourceComposePage', () => {
  describe('Basic Rendering - New Resource Mode', () => {
    it('renders without crashing', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      expect(screen.getByText('Compose Resource')).toBeInTheDocument();
    });

    it('renders resource name input', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      expect(screen.getByLabelText('Resource Name')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Enter resource name')).toBeInTheDocument();
    });

    it('renders entity type selection', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      expect(screen.getByText('Entity Types')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Document entity type/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Article entity type/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Report entity type/ })).toBeInTheDocument();
    });

    it('renders language selector', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      expect(screen.getByLabelText('Language')).toBeInTheDocument();
    });

    it('renders content source toggle', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      expect(screen.getByText('Upload File')).toBeInTheDocument();
      expect(screen.getByText('Write Content')).toBeInTheDocument();
    });

    it('renders toolbar component', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      expect(screen.getByTestId('toolbar')).toBeInTheDocument();
    });
  });

  describe('Clone Mode', () => {
    it('shows clone title', () => {
      const props = createMockProps({
        mode: 'clone',
        cloneData: {
          sourceResource: {
            '@id': 'http://localhost/resources/1',
            name: 'Original Resource',
          } as any,
          sourceContent: 'Original content',
        },
      });
      render(<ResourceComposePage {...props} />);

      expect(screen.getByText('Edit Cloned Resource')).toBeInTheDocument();
      expect(screen.getByText('Editing a cloned resource')).toBeInTheDocument();
    });

    it('initializes with cloned data', () => {
      const props = createMockProps({
        mode: 'clone',
        cloneData: {
          sourceResource: {
            '@id': 'http://localhost/resources/1',
            name: 'Original Resource',
          } as any,
          sourceContent: 'Original content',
        },
      });
      render(<ResourceComposePage {...props} />);

      const nameInput = screen.getByLabelText('Resource Name') as HTMLInputElement;
      expect(nameInput.value).toBe('Original Resource');

      const editor = screen.getByTestId('code-editor') as HTMLTextAreaElement;
      expect(editor.value).toBe('Original content');
    });

    it('shows archive original checkbox', () => {
      const props = createMockProps({
        mode: 'clone',
        cloneData: {
          sourceResource: {
            '@id': 'http://localhost/resources/1',
            name: 'Original Resource',
          } as any,
          sourceContent: 'Original content',
        },
      });
      render(<ResourceComposePage {...props} />);

      expect(screen.getByLabelText('Archive original resource')).toBeInTheDocument();
    });

    it('does not show content source toggle', () => {
      const props = createMockProps({
        mode: 'clone',
        cloneData: {
          sourceResource: {
            '@id': 'http://localhost/resources/1',
            name: 'Original Resource',
          } as any,
          sourceContent: 'Original content',
        },
      });
      render(<ResourceComposePage {...props} />);

      expect(screen.queryByText('Upload File')).not.toBeInTheDocument();
      expect(screen.queryByText('Write Content')).not.toBeInTheDocument();
    });
  });

  describe('Reference Completion Mode', () => {
    it('shows reference completion title', () => {
      const props = createMockProps({
        mode: 'reference',
        referenceData: {
          referenceId: 'ref-1',
          sourceDocumentId: 'doc-1',
          name: 'Referenced Resource',
          entityTypes: ['Document'],
        },
      });
      render(<ResourceComposePage {...props} />);

      expect(screen.getByText('Complete Reference')).toBeInTheDocument();
      expect(screen.getByText('Creating a new resource for reference')).toBeInTheDocument();
      expect(screen.getByText('This resource will be linked')).toBeInTheDocument();
    });

    it('initializes with reference data', () => {
      const props = createMockProps({
        mode: 'reference',
        referenceData: {
          referenceId: 'ref-1',
          sourceDocumentId: 'doc-1',
          name: 'Referenced Resource',
          entityTypes: ['Document', 'Article'],
        },
      });
      render(<ResourceComposePage {...props} />);

      const nameInput = screen.getByLabelText('Resource Name') as HTMLInputElement;
      expect(nameInput.value).toBe('Referenced Resource');

      expect(screen.getByText('Document')).toBeInTheDocument();
      expect(screen.getByText('Article')).toBeInTheDocument();
    });

    it('shows entity types as read-only when provided', () => {
      const props = createMockProps({
        mode: 'reference',
        referenceData: {
          referenceId: 'ref-1',
          sourceDocumentId: 'doc-1',
          name: 'Referenced Resource',
          entityTypes: ['Document'],
        },
      });
      render(<ResourceComposePage {...props} />);

      // Should show read-only entity types
      expect(screen.getByText('Document')).toBeInTheDocument();

      // Should not show selectable buttons
      expect(screen.queryByRole('button', { name: /Document entity type/ })).not.toBeInTheDocument();
    });
  });

  describe('Entity Type Selection', () => {
    it('allows selecting entity types', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      const documentButton = screen.getByRole('button', { name: /Document entity type/ });
      fireEvent.click(documentButton);

      expect(documentButton).toHaveClass('bg-blue-600');
    });

    it('allows deselecting entity types', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      const documentButton = screen.getByRole('button', { name: /Document entity type/ });

      // Select
      fireEvent.click(documentButton);
      expect(documentButton).toHaveClass('bg-blue-600');

      // Deselect
      fireEvent.click(documentButton);
      expect(documentButton).not.toHaveClass('bg-blue-600');
    });

    it('allows selecting multiple entity types', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      const documentButton = screen.getByRole('button', { name: /Document entity type/ });
      const articleButton = screen.getByRole('button', { name: /Article entity type/ });

      fireEvent.click(documentButton);
      fireEvent.click(articleButton);

      expect(documentButton).toHaveClass('bg-blue-600');
      expect(articleButton).toHaveClass('bg-blue-600');
    });
  });

  describe('Content Input Method', () => {
    it('defaults to write mode', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      const writeButton = screen.getByText('Write Content').closest('button');
      expect(writeButton).toHaveClass('border-blue-500');
    });

    it('allows switching to upload mode', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      const uploadButton = screen.getByText('Upload File').closest('button');
      fireEvent.click(uploadButton!);

      expect(uploadButton).toHaveClass('border-blue-500');
    });

    it('shows format selector in write mode', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      expect(screen.getByLabelText('Format')).toBeInTheDocument();
    });

    it('shows encoding selector in write mode', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      expect(screen.getByLabelText('Encoding')).toBeInTheDocument();
    });

    it('shows code editor in write mode', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });

    it('shows file upload in upload mode', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      const uploadButton = screen.getByText('Upload File').closest('button');
      fireEvent.click(uploadButton!);

      expect(screen.getByText('Drop file or click')).toBeInTheDocument();
    });
  });

  describe('Form Submission', () => {
    it('calls onSaveResource with correct params for new resource', async () => {
      const onSaveResource = vi.fn().mockResolvedValue(undefined);
      const props = createMockProps({ onSaveResource });
      render(<ResourceComposePage {...props} />);

      // Fill in name
      const nameInput = screen.getByLabelText('Resource Name');
      fireEvent.change(nameInput, { target: { value: 'Test Resource' } });

      // Fill in content
      const editor = screen.getByTestId('code-editor');
      fireEvent.change(editor, { target: { value: 'Test content' } });

      // Submit form
      const submitButton = screen.getByRole('button', { name: 'Create Resource' });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(onSaveResource).toHaveBeenCalledWith({
          mode: 'new',
          name: 'Test Resource',
          content: 'Test content',
          file: undefined,
          format: 'text/markdown',
          charset: undefined,
          entityTypes: [],
          language: 'en',
          archiveOriginal: undefined,
          referenceId: undefined,
          sourceDocumentId: undefined,
        });
      });
    });

    it('includes selected entity types', async () => {
      const onSaveResource = vi.fn().mockResolvedValue(undefined);
      const props = createMockProps({ onSaveResource });
      render(<ResourceComposePage {...props} />);

      // Fill in name
      const nameInput = screen.getByLabelText('Resource Name');
      fireEvent.change(nameInput, { target: { value: 'Test Resource' } });

      // Select entity type
      const documentButton = screen.getByRole('button', { name: /Document entity type/ });
      fireEvent.click(documentButton);

      // Submit form
      const submitButton = screen.getByRole('button', { name: 'Create Resource' });
      fireEvent.click(submitButton);

      await waitFor(() => {
        expect(onSaveResource).toHaveBeenCalledWith(
          expect.objectContaining({
            entityTypes: ['Document'],
          })
        );
      });
    });

    it('requires resource name', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      const submitButton = screen.getByRole('button', { name: 'Create Resource' });
      expect(submitButton).toBeDisabled();
    });

    it('enables submit button when name is provided', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      const nameInput = screen.getByLabelText('Resource Name');
      fireEvent.change(nameInput, { target: { value: 'Test Resource' } });

      const submitButton = screen.getByRole('button', { name: 'Create Resource' });
      expect(submitButton).not.toBeDisabled();
    });

    it('disables form during submission', async () => {
      const onSaveResource = vi.fn(() => new Promise<void>(resolve => setTimeout(resolve, 100)));
      const props = createMockProps({ onSaveResource });
      render(<ResourceComposePage {...props} />);

      const nameInput = screen.getByLabelText('Resource Name');
      fireEvent.change(nameInput, { target: { value: 'Test Resource' } });

      const submitButton = screen.getByRole('button', { name: 'Create Resource' });
      fireEvent.click(submitButton);

      // Button should show loading state
      expect(screen.getByRole('button', { name: 'Creating...' })).toBeInTheDocument();
      expect(nameInput).toBeDisabled();

      // Wait for the async operation to complete
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Create Resource' })).toBeInTheDocument();
      });
    });

    it('calls onCancel when cancel button clicked', () => {
      const onCancel = vi.fn();
      const props = createMockProps({ onCancel });
      render(<ResourceComposePage {...props} />);

      const cancelButton = screen.getByRole('button', { name: 'Cancel' });
      fireEvent.click(cancelButton);

      expect(onCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('Toolbar Integration', () => {
    it('renders ToolbarPanels component', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      expect(screen.getByTestId('toolbar-panels')).toBeInTheDocument();
    });

    it('passes theme props to ToolbarPanels', () => {
      const ToolbarPanels = vi.fn(() => <div data-testid="toolbar-panels" />);
      const props = createMockProps({
        theme: 'dark',
        onThemeChange: vi.fn(),
        ToolbarPanels,
      });

      render(<ResourceComposePage {...props} />);

      expect(ToolbarPanels).toHaveBeenCalledWith(
        expect.objectContaining({
          theme: 'dark',
          onThemeChange: expect.any(Function),
        }),
        expect.anything()
      );
    });
  });

  describe('Code Editor Integration', () => {
    it('allows editing content', () => {
      const props = createMockProps();
      render(<ResourceComposePage {...props} />);

      const editor = screen.getByTestId('code-editor') as HTMLTextAreaElement;
      fireEvent.change(editor, { target: { value: 'New content' } });

      expect(editor.value).toBe('New content');
    });

    it('respects showLineNumbers prop', () => {
      const props = createMockProps({ showLineNumbers: true });
      render(<ResourceComposePage {...props} />);

      expect(screen.getByTestId('code-editor')).toBeInTheDocument();
    });
  });
});
