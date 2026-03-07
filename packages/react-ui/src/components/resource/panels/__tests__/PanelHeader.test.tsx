import { describe, it, expect } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../../../test-utils';
import { PanelHeader } from '../PanelHeader';

describe('PanelHeader', () => {
  it('should render the title text', () => {
    renderWithProviders(
      <PanelHeader annotationType="highlight" count={5} title="Highlights" />
    );

    expect(screen.getByText('Highlights')).toBeInTheDocument();
  });

  it('should render the count in parentheses', () => {
    renderWithProviders(
      <PanelHeader annotationType="comment" count={12} title="Comments" />
    );

    expect(screen.getByText('(12)')).toBeInTheDocument();
  });

  it('should render with zero count', () => {
    renderWithProviders(
      <PanelHeader annotationType="tag" count={0} title="Tags" />
    );

    expect(screen.getByText('(0)')).toBeInTheDocument();
    expect(screen.getByText('Tags')).toBeInTheDocument();
  });

  it('should render with different annotation types', () => {
    const types = ['highlight', 'reference', 'assessment', 'comment', 'tag'] as const;

    for (const type of types) {
      const { unmount } = renderWithProviders(
        <PanelHeader annotationType={type} count={3} title={`${type} title`} />
      );

      expect(screen.getByText(`${type} title`)).toBeInTheDocument();
      expect(screen.getByText('(3)')).toBeInTheDocument();
      unmount();
    }
  });

  it('should render with correct class names', () => {
    const { container } = renderWithProviders(
      <PanelHeader annotationType="highlight" count={1} title="Highlights" />
    );

    expect(container.querySelector('.semiont-panel-header')).toBeInTheDocument();
    expect(container.querySelector('.semiont-panel-header__title')).toBeInTheDocument();
    expect(container.querySelector('.semiont-panel-header__text')).toBeInTheDocument();
    expect(container.querySelector('.semiont-panel-header__count')).toBeInTheDocument();
  });

  it('should render title inside an h2 element', () => {
    renderWithProviders(
      <PanelHeader annotationType="assessment" count={7} title="Assessments" />
    );

    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveTextContent('Assessments');
    expect(heading).toHaveTextContent('(7)');
  });
});
