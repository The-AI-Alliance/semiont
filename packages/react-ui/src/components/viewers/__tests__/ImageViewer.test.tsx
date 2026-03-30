import { describe, it, expect } from 'vitest';
import React from 'react';
import { screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { renderWithProviders } from '../../../test-utils';
import { ImageViewer } from '../ImageViewer';
import type { ResourceId } from '@semiont/core';

describe('ImageViewer', () => {
  const defaultProps = {
    resourceUri: 'abc-123' as ResourceId,
    mimeType: 'image/png',
  };

  it('should render an img element with correct src derived from URI', () => {
    renderWithProviders(<ImageViewer {...defaultProps} />);

    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'http://localhost:4000/resources/abc-123');
  });

  it('should use default alt text when none provided', () => {
    renderWithProviders(<ImageViewer {...defaultProps} />);

    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('alt', 'Resource image');
  });

  it('should use custom alt text when provided', () => {
    renderWithProviders(
      <ImageViewer {...defaultProps} alt="A beautiful diagram" />
    );

    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('alt', 'A beautiful diagram');
  });

  it('should extract the last segment of the URI as resource ID', () => {
    renderWithProviders(
      <ImageViewer
        resourceUri={'resource-xyz' as ResourceId}
        mimeType="image/jpeg"
      />
    );

    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'http://localhost:4000/resources/resource-xyz');
  });

  it('should render with correct class names', () => {
    const { container } = renderWithProviders(<ImageViewer {...defaultProps} />);

    expect(container.querySelector('.semiont-image-viewer')).toBeInTheDocument();
    expect(container.querySelector('.semiont-image-viewer__image')).toBeInTheDocument();
  });

  it('should set imageRendering style to auto', () => {
    renderWithProviders(<ImageViewer {...defaultProps} />);

    const img = screen.getByRole('img');
    expect(img).toHaveStyle({ imageRendering: 'auto' });
  });
});
