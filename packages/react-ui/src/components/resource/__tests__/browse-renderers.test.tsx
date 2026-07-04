/**
 * EMBEDDABLE-VIEWER-COMPLETION Phase 0 — regression: the browse `text` default
 * renders markdown as **formatted prose**, not raw source.
 *
 * The other BrowseView suites mock `react-markdown` away for simplicity, so
 * nothing currently pins that the default text renderer actually *formats*
 * markdown. This spec uses the real renderer and guards against a regression to
 * raw/source rendering.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import '@testing-library/jest-dom';
import { TextBrowseRenderer, defaultBrowseRenderers } from '../browse-renderers';

const base = { mimeType: 'text/markdown', resourceUri: 'res-1', annotations: [] };

describe('browse-renderers — markdown-as-prose (Phase 0 regression)', () => {
  it('TextBrowseRenderer is the default `text` renderer', () => {
    expect(defaultBrowseRenderers.text).toBe(TextBrowseRenderer);
  });

  it('renders markdown as formatted HTML, not raw source', () => {
    const { container } = render(
      <TextBrowseRenderer content={'# Big Heading\n\nsome **bold** and a [link](https://x.test).'} {...base} />,
    );
    // Formatted: heading / strong / anchor elements exist (react-markdown output).
    expect(container.querySelector('h1')?.textContent).toBe('Big Heading');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://x.test');
    // NOT raw: the literal markdown syntax must not survive to the text content.
    expect(container.textContent).not.toContain('# Big Heading');
    expect(container.textContent).not.toContain('**bold**');
  });
});
