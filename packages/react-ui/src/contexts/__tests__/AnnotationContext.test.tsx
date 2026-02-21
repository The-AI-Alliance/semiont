import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { AnnotationProvider, useAnnotationManager } from '../AnnotationContext';
import type { AnnotationManager, CreateAnnotationParams, DeleteAnnotationParams } from '../../types/AnnotationManager';
import { resourceUri } from '@semiont/core';

// Test component that uses the hook
function TestConsumer() {
  const manager = useAnnotationManager();

  return (
    <div>
      <div data-testid="has-manager">{manager ? 'yes' : 'no'}</div>
      <button
        data-testid="create-btn"
        onClick={() =>
          manager.createAnnotation({
            rUri: resourceUri('http://localhost/resources/test-123'),
            motivation: 'highlighting',
            selector: { type: 'TextQuoteSelector', exact: 'test' }
          })
        }
      >
        Create
      </button>
      <button
        data-testid="delete-btn"
        onClick={() =>
          manager.deleteAnnotation({
            annotationId: 'ann-123',
            rUri: resourceUri('http://localhost/resources/test-123')
          })
        }
      >
        Delete
      </button>
    </div>
  );
}

describe('AnnotationContext', () => {
  describe('AnnotationProvider', () => {
    it('should provide annotation manager to child components', () => {
      const mockManager: AnnotationManager = {
        createAnnotation: vi.fn().mockResolvedValue({ id: 'ann-123' }),
        deleteAnnotation: vi.fn().mockResolvedValue(undefined)
      };

      render(
        <AnnotationProvider annotationManager={mockManager}>
          <TestConsumer />
        </AnnotationProvider>
      );

      expect(screen.getByTestId('has-manager')).toHaveTextContent('yes');
    });

    it('should allow calling createAnnotation through manager', async () => {
      const mockCreate = vi.fn().mockResolvedValue({ id: 'ann-123' });
      const mockManager: AnnotationManager = {
        createAnnotation: mockCreate,
        deleteAnnotation: vi.fn()
      };

      render(
        <AnnotationProvider annotationManager={mockManager}>
          <TestConsumer />
        </AnnotationProvider>
      );

      const createBtn = screen.getByTestId('create-btn');
      createBtn.click();

      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalledWith({
          rUri: resourceUri('http://localhost/resources/test-123'),
          motivation: 'highlighting',
          selector: { type: 'TextQuoteSelector', exact: 'test' }
        });
      });
    });

    it('should allow calling deleteAnnotation through manager', async () => {
      const mockDelete = vi.fn().mockResolvedValue(undefined);
      const mockManager: AnnotationManager = {
        createAnnotation: vi.fn(),
        deleteAnnotation: mockDelete
      };

      render(
        <AnnotationProvider annotationManager={mockManager}>
          <TestConsumer />
        </AnnotationProvider>
      );

      const deleteBtn = screen.getByTestId('delete-btn');
      deleteBtn.click();

      await waitFor(() => {
        expect(mockDelete).toHaveBeenCalledWith({
          annotationId: 'ann-123',
          rUri: resourceUri('http://localhost/resources/test-123')
        });
      });
    });

    it('should render children', () => {
      const mockManager: AnnotationManager = {
        createAnnotation: vi.fn(),
        deleteAnnotation: vi.fn()
      };

      render(
        <AnnotationProvider annotationManager={mockManager}>
          <div data-testid="child">Child content</div>
        </AnnotationProvider>
      );

      expect(screen.getByTestId('child')).toHaveTextContent('Child content');
    });

    it('should update when manager changes', async () => {
      const mockCreate1 = vi.fn().mockResolvedValue({ id: 'ann-1' });
      const mockManager1: AnnotationManager = {
        createAnnotation: mockCreate1,
        deleteAnnotation: vi.fn()
      };

      const { rerender } = render(
        <AnnotationProvider annotationManager={mockManager1}>
          <TestConsumer />
        </AnnotationProvider>
      );

      const createBtn = screen.getByTestId('create-btn');
      createBtn.click();

      await waitFor(() => {
        expect(mockCreate1).toHaveBeenCalledTimes(1);
      });

      const mockCreate2 = vi.fn().mockResolvedValue({ id: 'ann-2' });
      const mockManager2: AnnotationManager = {
        createAnnotation: mockCreate2,
        deleteAnnotation: vi.fn()
      };

      rerender(
        <AnnotationProvider annotationManager={mockManager2}>
          <TestConsumer />
        </AnnotationProvider>
      );

      createBtn.click();

      await waitFor(() => {
        expect(mockCreate2).toHaveBeenCalledTimes(1);
        expect(mockCreate1).toHaveBeenCalledTimes(1); // Still 1 from before
      });
    });
  });

  describe('useAnnotationManager', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleError = console.error;
      console.error = () => {};

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useAnnotationManager must be used within an AnnotationProvider');

      console.error = consoleError;
    });

    it('should return manager from context', () => {
      const mockManager: AnnotationManager = {
        createAnnotation: vi.fn(),
        deleteAnnotation: vi.fn()
      };

      render(
        <AnnotationProvider annotationManager={mockManager}>
          <TestConsumer />
        </AnnotationProvider>
      );

      expect(screen.getByTestId('has-manager')).toBeInTheDocument();
      expect(screen.getByTestId('has-manager')).toHaveTextContent('yes');
    });
  });

  describe('Provider Pattern Integration', () => {
    it('should accept any AnnotationManager implementation', async () => {
      // Custom implementation (e.g., with localStorage instead of API)
      class CustomAnnotationManager implements AnnotationManager {
        async createAnnotation(params: CreateAnnotationParams) {
          return { id: `custom-${params.motivation}`, motivation: params.motivation };
        }

        async deleteAnnotation(params: DeleteAnnotationParams) {
          // Custom deletion logic
        }
      }

      const customManager = new CustomAnnotationManager();
      const createSpy = vi.spyOn(customManager, 'createAnnotation');

      render(
        <AnnotationProvider annotationManager={customManager}>
          <TestConsumer />
        </AnnotationProvider>
      );

      const createBtn = screen.getByTestId('create-btn');
      createBtn.click();

      await waitFor(() => {
        expect(createSpy).toHaveBeenCalled();
      });
    });

    it('should work with nested providers', () => {
      const outerManager: AnnotationManager = {
        createAnnotation: vi.fn().mockResolvedValue({ id: 'outer-ann' }),
        deleteAnnotation: vi.fn()
      };

      const innerManager: AnnotationManager = {
        createAnnotation: vi.fn().mockResolvedValue({ id: 'inner-ann' }),
        deleteAnnotation: vi.fn()
      };

      function InnerConsumer() {
        const manager = useAnnotationManager();
        return <div data-testid="inner-manager">{manager ? 'yes' : 'no'}</div>;
      }

      function OuterConsumer() {
        const manager = useAnnotationManager();
        return (
          <div>
            <div data-testid="outer-manager">{manager ? 'yes' : 'no'}</div>
            <AnnotationProvider annotationManager={innerManager}>
              <InnerConsumer />
            </AnnotationProvider>
          </div>
        );
      }

      render(
        <AnnotationProvider annotationManager={outerManager}>
          <OuterConsumer />
        </AnnotationProvider>
      );

      expect(screen.getByTestId('outer-manager')).toHaveTextContent('yes');
      expect(screen.getByTestId('inner-manager')).toHaveTextContent('yes');
    });

    it('should use innermost provider when nested', async () => {
      const outerCreate = vi.fn().mockResolvedValue({ id: 'outer-ann' });
      const outerManager: AnnotationManager = {
        createAnnotation: outerCreate,
        deleteAnnotation: vi.fn()
      };

      const innerCreate = vi.fn().mockResolvedValue({ id: 'inner-ann' });
      const innerManager: AnnotationManager = {
        createAnnotation: innerCreate,
        deleteAnnotation: vi.fn()
      };

      function NestedConsumer() {
        const manager = useAnnotationManager();
        return (
          <button
            data-testid="nested-create"
            onClick={() =>
              manager.createAnnotation({
                rUri: resourceUri('http://localhost/resources/test'),
                motivation: 'highlighting',
                selector: { type: 'TextQuoteSelector', exact: 'test' }
              })
            }
          >
            Create
          </button>
        );
      }

      render(
        <AnnotationProvider annotationManager={outerManager}>
          <AnnotationProvider annotationManager={innerManager}>
            <NestedConsumer />
          </AnnotationProvider>
        </AnnotationProvider>
      );

      const createBtn = screen.getByTestId('nested-create');
      createBtn.click();

      await waitFor(() => {
        expect(innerCreate).toHaveBeenCalledTimes(1);
        expect(outerCreate).not.toHaveBeenCalled();
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle multiple components using same manager', async () => {
      const mockCreate = vi.fn().mockResolvedValue({ id: 'shared-ann' });
      const mockManager: AnnotationManager = {
        createAnnotation: mockCreate,
        deleteAnnotation: vi.fn()
      };

      function Consumer1() {
        const manager = useAnnotationManager();
        return (
          <button
            data-testid="consumer1-create"
            onClick={() =>
              manager.createAnnotation({
                rUri: resourceUri('http://localhost/resources/test'),
                motivation: 'highlighting',
                selector: { type: 'TextQuoteSelector', exact: 'test1' }
              })
            }
          >
            Create 1
          </button>
        );
      }

      function Consumer2() {
        const manager = useAnnotationManager();
        return (
          <button
            data-testid="consumer2-create"
            onClick={() =>
              manager.createAnnotation({
                rUri: resourceUri('http://localhost/resources/test'),
                motivation: 'commenting',
                selector: { type: 'TextQuoteSelector', exact: 'test2' }
              })
            }
          >
            Create 2
          </button>
        );
      }

      render(
        <AnnotationProvider annotationManager={mockManager}>
          <Consumer1 />
          <Consumer2 />
        </AnnotationProvider>
      );

      screen.getByTestId('consumer1-create').click();
      screen.getByTestId('consumer2-create').click();

      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalledTimes(2);
      });
    });

    it('should handle errors from createAnnotation', async () => {
      const mockCreate = vi.fn().mockRejectedValue(new Error('Create failed'));
      const mockManager: AnnotationManager = {
        createAnnotation: mockCreate,
        deleteAnnotation: vi.fn()
      };

      function ErrorConsumer() {
        const manager = useAnnotationManager();
        const [error, setError] = React.useState<string | null>(null);

        return (
          <div>
            <button
              data-testid="create-with-error"
              onClick={async () => {
                try {
                  await manager.createAnnotation({
                    rUri: resourceUri('http://localhost/resources/test'),
                    motivation: 'highlighting',
                    selector: { type: 'TextQuoteSelector', exact: 'test' }
                  });
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              Create
            </button>
            <div data-testid="error-message">{error || 'no-error'}</div>
          </div>
        );
      }

      render(
        <AnnotationProvider annotationManager={mockManager}>
          <ErrorConsumer />
        </AnnotationProvider>
      );

      screen.getByTestId('create-with-error').click();

      await waitFor(() => {
        expect(screen.getByTestId('error-message')).toHaveTextContent('Create failed');
      });
    });

    it('should handle errors from deleteAnnotation', async () => {
      const mockDelete = vi.fn().mockRejectedValue(new Error('Delete failed'));
      const mockManager: AnnotationManager = {
        createAnnotation: vi.fn(),
        deleteAnnotation: mockDelete
      };

      function ErrorConsumer() {
        const manager = useAnnotationManager();
        const [error, setError] = React.useState<string | null>(null);

        return (
          <div>
            <button
              data-testid="delete-with-error"
              onClick={async () => {
                try {
                  await manager.deleteAnnotation({
                    annotationId: 'ann-123',
                    rUri: resourceUri('http://localhost/resources/test')
                  });
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              Delete
            </button>
            <div data-testid="error-message">{error || 'no-error'}</div>
          </div>
        );
      }

      render(
        <AnnotationProvider annotationManager={mockManager}>
          <ErrorConsumer />
        </AnnotationProvider>
      );

      screen.getByTestId('delete-with-error').click();

      await waitFor(() => {
        expect(screen.getByTestId('error-message')).toHaveTextContent('Delete failed');
      });
    });
  });
});
