import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../../../test-utils';
import { PanelHeader } from '../PanelHeader';

describe('PanelHeader', () => {
  it('should render the title text', () => {
    renderWithProviders(
      <PanelHeader count={5} title="Highlights" />
    );

    expect(screen.getByText('Highlights')).toBeInTheDocument();
  });

  it('should render the count in parentheses', () => {
    renderWithProviders(
      <PanelHeader count={12} title="Comments" />
    );

    expect(screen.getByText('(12)')).toBeInTheDocument();
  });

  it('should render with zero count', () => {
    renderWithProviders(
      <PanelHeader count={0} title="Tags" />
    );

    expect(screen.getByText('(0)')).toBeInTheDocument();
    expect(screen.getByText('Tags')).toBeInTheDocument();
  });

  it('should render with correct class names', () => {
    const { container } = renderWithProviders(
      <PanelHeader count={1} title="Highlights" />
    );

    expect(container.querySelector('.semiont-panel-header')).toBeInTheDocument();
    expect(container.querySelector('.semiont-panel-header__title')).toBeInTheDocument();
    expect(container.querySelector('.semiont-panel-header__text')).toBeInTheDocument();
    expect(container.querySelector('.semiont-panel-header__count')).toBeInTheDocument();
  });

  it('should render title inside an h2 element', () => {
    renderWithProviders(
      <PanelHeader count={7} title="Assessments" />
    );

    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveTextContent('Assessments');
    expect(heading).toHaveTextContent('(7)');
  });
});
