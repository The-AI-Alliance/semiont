/**
 * TOOLBAR-PREFS-AS-PROPS — keystone + per-pref specs.
 *
 * Preferences are state, not events: each of the four toolbar prefs (mode, click
 * action, selection motivation, shape) is a controlled/uncontrolled prop pair.
 * Controlled instances render the given value and report intents via the callback —
 * never self-mutate, never touch localStorage, never hear other instances.
 * Uncontrolled instances hold a plain internal default (false / 'detail' /
 * 'linking' / 'rectangle') — NOT the legacy localStorage+bus behavior (that lives
 * in the useToolbarPrefs() policy layer).
 *
 * RED ledger: authored `it.fails` (observed: 5 expected fail), flipped to `it` at
 * Phase 1 GREEN. Provider-free; real AnnotateToolbar (its controls are the subject).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { ResourceDescriptor as SemiontResource, ResourceId } from '@semiont/core';
import { ResourceViewer } from '../ResourceViewer';

vi.mock('../../CodeMirrorRenderer', () => ({ CodeMirrorRenderer: () => <div>cm-mock</div> }));
vi.mock('../../image-annotation/SvgDrawingCanvas', () => ({ SvgDrawingCanvas: () => <div>svg-mock</div> }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));

function makeResource(mediaType = 'text/plain'): SemiontResource & { content: string } {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    '@id': 'res-1' as ResourceId,
    name: 'Doc',
    created: '2024-01-01T00:00:00Z',
    entityTypes: [],
    archived: false,
    representations: [{ mediaType, byteSize: 10 }],
    content: 'Prefs content.',
  };
}

const annotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

/** Session double with a live subscribe registry so specs can fire legacy broadcasts. */
function liveSession() {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const client = {
    browse: { click: vi.fn(), invalidateAnnotationList: vi.fn() },
    beckon: { hover: vi.fn() },
    mark: {
      toggleMode: vi.fn(), delete: vi.fn(), request: vi.fn(),
      changeSelection: vi.fn(), changeClick: vi.fn(), changeShape: vi.fn(),
    },
  };
  const session = {
    client,
    subscribe: (channel: string, handler: (p: unknown) => void) => {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(handler);
      return () => { handlers.get(channel)!.delete(handler); };
    },
  } as unknown as SemiontSession;
  const fire = (channel: string, payload?: unknown) =>
    handlers.get(channel)?.forEach((h) => h(payload));
  return { session, client, fire };
}

const isAnnotate = (c: HTMLElement) => !!c.querySelector('.semiont-annotate-view');
const isBrowse = (c: HTMLElement) => !!c.querySelector('.semiont-browse-view');

/** Open a bar dropdown group by aria-label and click an option in its menu. */
async function pick(container: HTMLElement, group: string, option: string) {
  const trigger = within(container).getByLabelText(group);
  fireEvent.mouseEnter(trigger.parentElement!);
  await waitFor(() => {
    const menu = within(container).getByRole('menu');
    fireEvent.click(within(menu).getByText(option));
  });
}

const PREF_KEYS = ['annotateMode', 'semiont-toolbar-click', 'semiont-toolbar-selection'];
let getSpy: ReturnType<typeof vi.spyOn>;
let setSpy: ReturnType<typeof vi.spyOn>;
const prefKeyTouched = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.some((call: unknown[]) => {
    const key = String(call[0]);
    return PREF_KEYS.includes(key) || key.includes('shape');
  });

describe('ResourceViewer — toolbar prefs as props', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    getSpy = vi.spyOn(Storage.prototype, 'getItem');
    setSpy = vi.spyOn(Storage.prototype, 'setItem');
  });
  afterEach(() => {
    getSpy.mockRestore();
    setSpy.mockRestore();
  });

  // ── Keystone: per-instance isolation across three viewers on one session ──
  it('keystone: three viewers — controlled A/B independent, C uncontrolled; B\'s Mode click fires only B\'s callback', async () => {
    const { session, client } = liveSession();
    const onB = vi.fn();
    const a = render(
      <ResourceViewer session={session} resource={makeResource()} annotations={annotations}
        annotateMode={true} clickAction="follow" onAnnotateModeChange={vi.fn()} onClickActionChange={vi.fn()} />,
    );
    const b = render(
      <ResourceViewer session={session} resource={makeResource()} annotations={annotations}
        annotateMode={false} onAnnotateModeChange={onB} />,
    );
    const c = render(
      <ResourceViewer session={session} resource={makeResource()} annotations={annotations} />,
    );

    expect(isAnnotate(a.container)).toBe(true);   // A renders its controlled mode
    expect(isBrowse(b.container)).toBe(true);
    expect(isBrowse(c.container)).toBe(true);     // C: plain default (false)

    await pick(b.container, 'Mode', 'Annotate');

    expect(onB).toHaveBeenCalledWith(true);                 // B reports intent…
    expect(isBrowse(b.container)).toBe(true);               // …and does not self-flip
    expect(isAnnotate(a.container)).toBe(true);             // A unchanged
    expect(isBrowse(c.container)).toBe(true);               // C unchanged
    expect(client.mark.toggleMode).not.toHaveBeenCalled();  // no global emit
    expect(prefKeyTouched(getSpy)).toBe(false);             // no localStorage traffic
    expect(prefKeyTouched(setSpy)).toBe(false);
  });

  // ── Per-pref: mode ──
  it('mode: uncontrolled uses the plain default and is inert to the legacy broadcast', () => {
    localStorage.setItem('annotateMode', 'true'); // legacy key must be IGNORED
    getSpy.mockClear(); setSpy.mockClear();
    const { session, fire } = liveSession();
    const u = render(
      <ResourceViewer session={session} resource={makeResource()} annotations={annotations} />,
    );
    expect(isBrowse(u.container)).toBe(true);      // plain default, not the stored 'true'
    fire('mark:mode-toggled');
    expect(isBrowse(u.container)).toBe(true);      // inert: preference events are gone
    expect(prefKeyTouched(getSpy)).toBe(false);
    expect(prefKeyTouched(setSpy)).toBe(false);
  });

  // ── Per-pref: click action ──
  it('clickAction: controlled renders the value; the bar control reports and does not mutate', async () => {
    const { session, client } = liveSession();
    const onChange = vi.fn();
    const v = render(
      <ResourceViewer session={session} resource={makeResource()} annotations={annotations}
        clickAction="follow" onClickActionChange={onChange} />,
    );
    const bar = v.container.querySelector('.semiont-annotate-toolbar') as HTMLElement;
    expect(within(bar).getByText('Follow')).toBeInTheDocument();  // renders the prop value

    await pick(v.container, 'Click', 'Detail');
    expect(onChange).toHaveBeenCalledWith('detail');              // reports intent
    expect(within(bar).getByText('Follow')).toBeInTheDocument();  // does not self-mutate
    expect(client.mark.changeClick).not.toHaveBeenCalled();
  });

  // ── Per-pref: selection motivation (annotate-mode bar) ──
  it('selectionMotivation: controlled renders the value; picking reports; re-picking the current reports null', async () => {
    const { session, client } = liveSession();
    const onChange = vi.fn();
    const v = render(
      <ResourceViewer session={session} resource={makeResource()} annotations={annotations}
        annotateMode={true} onAnnotateModeChange={vi.fn()}
        selectionMotivation="highlighting" onSelectionMotivationChange={onChange} />,
    );
    const bar = v.container.querySelector('.semiont-annotate-toolbar') as HTMLElement;
    expect(within(bar).getByText('Highlight')).toBeInTheDocument(); // renders the prop value

    await pick(v.container, 'Motivation', 'Comment');
    expect(onChange).toHaveBeenCalledWith('commenting');

    await pick(v.container, 'Motivation', 'Highlight');             // current value → toggles off
    expect(onChange).toHaveBeenCalledWith(null);
    expect(client.mark.changeSelection).not.toHaveBeenCalled();
  });

  // ── Per-pref: shape (media-gated; image annotate bar) ──
  it('shape: controlled renders the value; picking reports and does not mutate', async () => {
    const { session, client } = liveSession();
    const onChange = vi.fn();
    const v = render(
      <ResourceViewer session={session} resource={makeResource('image/png')} annotations={annotations}
        annotateMode={true} onAnnotateModeChange={vi.fn()}
        shape="circle" onShapeChange={onChange} />,
    );
    const bar = v.container.querySelector('.semiont-annotate-toolbar') as HTMLElement;
    expect(within(bar).getByText('Circle')).toBeInTheDocument();    // renders the prop value

    await pick(v.container, 'Shape', 'Polygon');
    expect(onChange).toHaveBeenCalledWith('polygon');
    expect(within(bar).getByText('Circle')).toBeInTheDocument();    // does not self-mutate
    expect(client.mark.changeShape).not.toHaveBeenCalled();
  });
});
