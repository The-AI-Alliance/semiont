/**
 * EMBEDDABLE-VIEWER-COMPLETION Phase 3 — Annotate Bar display forms.
 *
 * Behavior is mostly fixed (the bar IS the annotation capability); the host
 * gets freedom over its display form. `compact` is a display-only variant:
 * icon-only, tight, chromeless — the functional groups stay present and wired.
 * BrowseView's `inline` embed shows the compact bar automatically. Theming
 * (semiont-* classes + CSS vars) and labels (i18n) already exist — no new API
 * for those.
 *
 * Started RED (no `compact` prop) and GREEN once Phase 3 lands.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SemiontSession } from '@semiont/sdk';
import { AnnotateToolbar } from '../AnnotateToolbar';
import { ANNOTATORS } from '../../../lib/annotation-registry';
import { BrowseView } from '../../resource/BrowseView';

vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));

const emptyAnnotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

function fakeSession(): SemiontSession {
  return {
    client: { browse: { click: vi.fn() }, beckon: { hover: vi.fn() }, mark: { toggleMode: vi.fn() } },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

const toolbarProps = {
  selectedMotivation: null,
  selectedClick: 'detail' as const,
  annotateMode: false,
  annotators: ANNOTATORS,
  session: null,
};

describe('Annotate Bar display forms (Phase 3)', () => {
  it('`compact` adds the display modifier; default does not', () => {
    const { container: normal } = render(<AnnotateToolbar {...toolbarProps} />);
    expect(normal.querySelector('.semiont-annotate-toolbar')).not.toHaveClass('semiont-annotate-toolbar--compact');

    const { container } = render(<AnnotateToolbar {...toolbarProps} compact />);
    expect(container.querySelector('.semiont-annotate-toolbar')).toHaveClass('semiont-annotate-toolbar--compact');
  });

  it('compact is display-only: the functional groups are still present', () => {
    render(<AnnotateToolbar {...toolbarProps} compact />);
    // Groups render with their aria labels (default-English translations, no provider).
    expect(screen.getByLabelText(/mode/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/click/i)).toBeInTheDocument();
  });

  it('BrowseView inline embeds show the compact bar automatically', () => {
    const props = {
      content: 'x', mimeType: 'text/plain', resourceUri: 'res-1',
      annotations: emptyAnnotations, annotateMode: false, session: fakeSession(),
    };
    const { container: pane } = render(<BrowseView {...props} />);
    expect(pane.querySelector('.semiont-annotate-toolbar')).not.toHaveClass('semiont-annotate-toolbar--compact');

    const { container } = render(<BrowseView {...props} inline />);
    expect(container.querySelector('.semiont-annotate-toolbar')).toHaveClass('semiont-annotate-toolbar--compact');
  });

  it('stylesheet carries the compact form (static gate — icon-only, chromeless)', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/components/toolbar/Toolbar.css'), 'utf8');
    expect(css).toMatch(/\.semiont-annotate-toolbar--compact\s*\{/);
    expect(css).toMatch(/\.semiont-annotate-toolbar--compact\s+\.semiont-dropdown-label\s*\{[^}]*display:\s*none/);
  });
});
