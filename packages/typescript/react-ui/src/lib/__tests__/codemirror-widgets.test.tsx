/**
 * The generating indicator is the one part of `ReferenceResolutionWidget`
 * whose colours depend on the theme. Its styles are inline, out of reach of
 * the stylesheet's `[data-theme="dark"]` rules, so the widget reads the theme
 * itself. The theme here is set by the real `ThemeProvider`: the widget and
 * the provider have to agree on the mark, or the indicator stays light on a
 * dark page with nothing failing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { resourceId } from '@semiont/core';
import type { Annotation, AnnotationId } from '@semiont/core';
import { ThemeProvider } from '../../contexts/ThemeContext';
import { ReferenceResolutionWidget } from '../codemirror-widgets';

const unresolvedReference: Annotation = {
  '@context': 'http://www.w3.org/ns/anno.jsonld',
  id: 'anno-1' as AnnotationId,
  type: 'Annotation',
  motivation: 'linking',
  creator: { '@type': 'Person', name: 'user@example.com' },
  created: '2024-01-01T10:00:00Z',
  target: {
    source: resourceId('resource-1'),
    selector: { type: 'TextPositionSelector', start: 0, end: 10 },
  },
};

/** The pulsing ring and the badge over it: the two children of the indicator's wrapper. */
function generatingIndicatorUnder(theme: 'light' | 'dark') {
  localStorage.setItem('theme', theme);
  render(<ThemeProvider>{null}</ThemeProvider>);

  const widget = new ReferenceResolutionWidget(unresolvedReference, undefined, true).toDOM();
  const [ping, badge] = widget.querySelectorAll<HTMLElement>('.reference-indicator > span > span');
  if (!ping || !badge) throw new Error('the generating indicator did not render its ring and badge');
  return { ping, badge };
}

describe('ReferenceResolutionWidget generating indicator', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
      writable: true,
      configurable: true,
    });
  });

  it("is light under ThemeProvider's light theme", () => {
    const { ping, badge } = generatingIndicatorUnder('light');

    expect(badge.style.backgroundColor).toBe('white');
    expect(ping.style.backgroundColor).toBe('rgb(250, 204, 21)');
  });

  it("is dark under ThemeProvider's dark theme", () => {
    const { ping, badge } = generatingIndicatorUnder('dark');

    expect(badge.style.backgroundColor).toBe('rgb(31, 41, 55)');
    expect(badge.style.borderColor).toBe('rgb(234, 179, 8)');
    expect(ping.style.backgroundColor).toBe('rgb(234, 179, 8)');
  });
});
