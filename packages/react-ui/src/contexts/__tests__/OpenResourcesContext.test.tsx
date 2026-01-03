import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { OpenResourcesProvider, useOpenResources } from '../OpenResourcesContext';
import type { OpenResourcesManager, OpenResource } from '../../types/OpenResourcesManager';

// Test component that uses the hook
function TestConsumer() {
  const { openResources, addResource, removeResource, updateResourceName, reorderResources } = useOpenResources();

  return (
    <div>
      <div data-testid="resource-count">{openResources.length}</div>
      <div data-testid="resources">
        {openResources.map(r => (
          <div key={r.id} data-testid={`resource-${r.id}`}>
            {r.name} ({r.mediaType || 'unknown'})
          </div>
        ))}
      </div>
      <button onClick={() => addResource('test-1', 'Test Resource 1', 'text/plain')}>Add Resource</button>
      <button onClick={() => removeResource('test-1')}>Remove Resource</button>
      <button onClick={() => updateResourceName('test-1', 'Updated Name')}>Update Name</button>
      <button onClick={() => reorderResources(0, 1)}>Reorder</button>
    </div>
  );
}

describe('OpenResourcesContext', () => {
  describe('OpenResourcesProvider', () => {
    it('should provide open resources manager to child components', () => {
      const mockResources: OpenResource[] = [
        { id: 'doc-1', name: 'Document 1', openedAt: Date.now(), mediaType: 'text/html' },
        { id: 'doc-2', name: 'Document 2', openedAt: Date.now(), mediaType: 'application/pdf' },
      ];

      const mockManager: OpenResourcesManager = {
        openResources: mockResources,
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      expect(screen.getByTestId('resource-count')).toHaveTextContent('2');
      expect(screen.getByTestId('resource-doc-1')).toHaveTextContent('Document 1 (text/html)');
      expect(screen.getByTestId('resource-doc-2')).toHaveTextContent('Document 2 (application/pdf)');
    });

    it('should handle empty resources list', () => {
      const mockManager: OpenResourcesManager = {
        openResources: [],
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      expect(screen.getByTestId('resource-count')).toHaveTextContent('0');
    });

    it('should handle resources without mediaType', () => {
      const mockResources: OpenResource[] = [
        { id: 'doc-1', name: 'Document 1', openedAt: Date.now() },
      ];

      const mockManager: OpenResourcesManager = {
        openResources: mockResources,
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      expect(screen.getByTestId('resource-doc-1')).toHaveTextContent('Document 1 (unknown)');
    });

    it('should provide addResource function', () => {
      const addResourceMock = vi.fn();
      const mockManager: OpenResourcesManager = {
        openResources: [],
        addResource: addResourceMock,
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      screen.getByText('Add Resource').click();
      expect(addResourceMock).toHaveBeenCalledWith('test-1', 'Test Resource 1', 'text/plain');
    });

    it('should provide removeResource function', () => {
      const removeResourceMock = vi.fn();
      const mockManager: OpenResourcesManager = {
        openResources: [],
        addResource: vi.fn(),
        removeResource: removeResourceMock,
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      screen.getByText('Remove Resource').click();
      expect(removeResourceMock).toHaveBeenCalledWith('test-1');
    });

    it('should provide updateResourceName function', () => {
      const updateResourceNameMock = vi.fn();
      const mockManager: OpenResourcesManager = {
        openResources: [],
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: updateResourceNameMock,
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      screen.getByText('Update Name').click();
      expect(updateResourceNameMock).toHaveBeenCalledWith('test-1', 'Updated Name');
    });

    it('should provide reorderResources function', () => {
      const reorderResourcesMock = vi.fn();
      const mockManager: OpenResourcesManager = {
        openResources: [],
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: reorderResourcesMock,
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      screen.getByText('Reorder').click();
      expect(reorderResourcesMock).toHaveBeenCalledWith(0, 1);
    });

    it('should render children', () => {
      const mockManager: OpenResourcesManager = {
        openResources: [],
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <div data-testid="child">Child content</div>
        </OpenResourcesProvider>
      );

      expect(screen.getByTestId('child')).toHaveTextContent('Child content');
    });

    it('should update when manager changes', () => {
      const mockManager1: OpenResourcesManager = {
        openResources: [{ id: 'doc-1', name: 'Document 1', openedAt: Date.now() }],
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      const { rerender } = render(
        <OpenResourcesProvider openResourcesManager={mockManager1}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      expect(screen.getByTestId('resource-count')).toHaveTextContent('1');

      const mockManager2: OpenResourcesManager = {
        openResources: [
          { id: 'doc-1', name: 'Document 1', openedAt: Date.now() },
          { id: 'doc-2', name: 'Document 2', openedAt: Date.now() },
        ],
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      rerender(
        <OpenResourcesProvider openResourcesManager={mockManager2}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      expect(screen.getByTestId('resource-count')).toHaveTextContent('2');
    });
  });

  describe('useOpenResources', () => {
    it('should throw error when used outside provider', () => {
      // Suppress console.error for this test
      const consoleError = console.error;
      console.error = () => {};

      expect(() => {
        render(<TestConsumer />);
      }).toThrow('useOpenResources must be used within an OpenResourcesProvider');

      console.error = consoleError;
    });

    it('should return manager from context', () => {
      const mockManager: OpenResourcesManager = {
        openResources: [],
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      // If no error is thrown and component renders, the hook works correctly
      expect(screen.getByTestId('resource-count')).toBeInTheDocument();
    });
  });

  describe('Provider Pattern Integration', () => {
    it('should accept any OpenResourcesManager implementation', () => {
      // Custom implementation (e.g., with database instead of localStorage)
      const customManager: OpenResourcesManager = {
        openResources: [{ id: 'remote-1', name: 'Remote Resource', openedAt: Date.now() }],
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={customManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      expect(screen.getByTestId('resource-remote-1')).toHaveTextContent('Remote Resource');
    });

    it('should work with nested providers', () => {
      const outerManager: OpenResourcesManager = {
        openResources: [{ id: 'outer-1', name: 'Outer Resource', openedAt: Date.now() }],
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      const innerManager: OpenResourcesManager = {
        openResources: [{ id: 'inner-1', name: 'Inner Resource', openedAt: Date.now() }],
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      function InnerConsumer() {
        const { openResources } = useOpenResources();
        return <div data-testid="inner-count">{openResources.length}</div>;
      }

      function OuterConsumer() {
        const { openResources } = useOpenResources();
        return (
          <div>
            <div data-testid="outer-count">{openResources.length}</div>
            <OpenResourcesProvider openResourcesManager={innerManager}>
              <InnerConsumer />
            </OpenResourcesProvider>
          </div>
        );
      }

      render(
        <OpenResourcesProvider openResourcesManager={outerManager}>
          <OuterConsumer />
        </OpenResourcesProvider>
      );

      expect(screen.getByTestId('outer-count')).toHaveTextContent('1');
      expect(screen.getByTestId('inner-count')).toHaveTextContent('1');
    });
  });

  describe('Edge Cases', () => {
    it('should handle resources with order field', () => {
      const mockResources: OpenResource[] = [
        { id: 'doc-1', name: 'Document 1', openedAt: Date.now(), order: 0 },
        { id: 'doc-2', name: 'Document 2', openedAt: Date.now(), order: 1 },
      ];

      const mockManager: OpenResourcesManager = {
        openResources: mockResources,
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      expect(screen.getByTestId('resource-count')).toHaveTextContent('2');
    });

    it('should handle very long resource names', () => {
      const longName = 'A'.repeat(1000);
      const mockResources: OpenResource[] = [
        { id: 'doc-1', name: longName, openedAt: Date.now() },
      ];

      const mockManager: OpenResourcesManager = {
        openResources: mockResources,
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      expect(screen.getByTestId('resource-doc-1')).toHaveTextContent(longName);
    });

    it('should handle special characters in resource IDs and names', () => {
      const mockResources: OpenResource[] = [
        { id: 'doc-#$%&', name: 'Resource <>&"\'', openedAt: Date.now() },
      ];

      const mockManager: OpenResourcesManager = {
        openResources: mockResources,
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      expect(screen.getByTestId('resource-doc-#$%&')).toBeInTheDocument();
    });

    it('should handle duplicate resource IDs', () => {
      // Manager implementation should handle this, but context should still work
      const mockResources: OpenResource[] = [
        { id: 'doc-1', name: 'Document 1', openedAt: Date.now() },
        { id: 'doc-1', name: 'Document 1 Duplicate', openedAt: Date.now() },
      ];

      const mockManager: OpenResourcesManager = {
        openResources: mockResources,
        addResource: vi.fn(),
        removeResource: vi.fn(),
        updateResourceName: vi.fn(),
        reorderResources: vi.fn(),
      };

      render(
        <OpenResourcesProvider openResourcesManager={mockManager}>
          <TestConsumer />
        </OpenResourcesProvider>
      );

      expect(screen.getByTestId('resource-count')).toHaveTextContent('2');
    });
  });
});
