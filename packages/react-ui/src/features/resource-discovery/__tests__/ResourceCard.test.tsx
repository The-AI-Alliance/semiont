/**
 * Tests for ResourceCard component
 *
 * Simple tests for a simple component. No mocking required.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResourceCard } from '../components/ResourceCard';
import type { ResourceCardProps } from '../components/ResourceCard';

const createMockResource = (overrides?: any) => ({
  '@context': 'https://www.w3.org/ns/anno.jsonld',
  '@id': 'http://localhost/resources/test-123',
  '@type': 'schema:DigitalDocument',
  name: 'Test Resource',
  description: 'A test resource',
  entityTypes: ['Document', 'Article'],
  archived: false,
  dateCreated: '2024-01-15T10:00:00Z',
  representations: [],
  ...overrides,
});

describe('ResourceCard', () => {
  describe('Basic Rendering', () => {
    it('renders resource name', () => {
      const resource = createMockResource();
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      expect(screen.getByText('Test Resource')).toBeInTheDocument();
    });

    it('renders creation date', () => {
      const resource = createMockResource();
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      expect(screen.getByText(/Created:/)).toBeInTheDocument();
      expect(screen.getByText(/1\/15\/2024/)).toBeInTheDocument();
    });

    it('renders entity type tags', () => {
      const resource = createMockResource({ entityTypes: ['Document', 'Article'] });
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      expect(screen.getByText('Document')).toBeInTheDocument();
      expect(screen.getByText('Article')).toBeInTheDocument();
    });

    it('shows +N indicator when more than 2 entity types', () => {
      const resource = createMockResource({
        entityTypes: ['Document', 'Article', 'Report', 'Paper'],
      });
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      expect(screen.getByText('Document')).toBeInTheDocument();
      expect(screen.getByText('Article')).toBeInTheDocument();
      expect(screen.getByText('+2')).toBeInTheDocument();
    });

    it('displays archived badge when resource is archived', () => {
      const resource = createMockResource({ archived: true });
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      expect(screen.getByText('Archived')).toBeInTheDocument();
    });

    it('does not display archived badge when resource is not archived', () => {
      const resource = createMockResource({ archived: false });
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      expect(screen.queryByText('Archived')).not.toBeInTheDocument();
    });

    it('shows N/A when no creation date', () => {
      const resource = createMockResource({ dateCreated: undefined });
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      expect(screen.getByText(/N\/A/)).toBeInTheDocument();
    });
  });

  describe('Click Interaction', () => {
    it('calls onOpen when clicked', () => {
      const resource = createMockResource();
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      const card = screen.getByRole('button', { name: /Open resource: Test Resource/ });
      fireEvent.click(card);

      expect(onOpen).toHaveBeenCalledWith(resource);
    });

    it('can be clicked multiple times', () => {
      const resource = createMockResource();
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      const card = screen.getByRole('button', { name: /Open resource: Test Resource/ });
      fireEvent.click(card);
      fireEvent.click(card);
      fireEvent.click(card);

      expect(onOpen).toHaveBeenCalledTimes(3);
    });
  });

  describe('Keyboard Navigation', () => {
    it('calls onOpen when Enter key is pressed', () => {
      const resource = createMockResource();
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      const card = screen.getByRole('button', { name: /Open resource: Test Resource/ });
      fireEvent.keyDown(card, { key: 'Enter' });

      expect(onOpen).toHaveBeenCalledWith(resource);
    });

    it('calls onOpen when Space key is pressed', () => {
      const resource = createMockResource();
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      const card = screen.getByRole('button', { name: /Open resource: Test Resource/ });
      fireEvent.keyDown(card, { key: ' ' });

      expect(onOpen).toHaveBeenCalledWith(resource);
    });

    it('does not call onOpen for other keys', () => {
      const resource = createMockResource();
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      const card = screen.getByRole('button', { name: /Open resource: Test Resource/ });
      fireEvent.keyDown(card, { key: 'a' });
      fireEvent.keyDown(card, { key: 'Escape' });
      fireEvent.keyDown(card, { key: 'Tab' });

      expect(onOpen).not.toHaveBeenCalled();
    });

    it('respects custom tabIndex', () => {
      const resource = createMockResource();
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          tabIndex={-1}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      const card = screen.getByRole('button', { name: /Open resource: Test Resource/ });
      expect(card).toHaveAttribute('tabindex', '-1');
    });

    it('uses default tabIndex of 0 when not specified', () => {
      const resource = createMockResource();
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      const card = screen.getByRole('button', { name: /Open resource: Test Resource/ });
      expect(card).toHaveAttribute('tabindex', '0');
    });
  });

  describe('Accessibility', () => {
    it('has proper ARIA label', () => {
      const resource = createMockResource();
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      expect(screen.getByRole('button', { name: 'Open resource: Test Resource' })).toBeInTheDocument();
    });

    it('has button role', () => {
      const resource = createMockResource();
      const onOpen = vi.fn();

      render(
        <ResourceCard
          resource={resource}
          onOpen={onOpen}
          archivedLabel="Archived"
          createdLabel="Created:"
        />
      );

      const card = screen.getByRole('button');
      expect(card).toBeInTheDocument();
    });
  });
});
