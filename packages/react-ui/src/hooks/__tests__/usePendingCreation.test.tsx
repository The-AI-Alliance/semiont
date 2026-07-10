/**
 * HEADLESS-CREATION-SEAM — usePendingCreation, the consuming half of the
 * capture/policy split.
 *
 * The viewer captures and emits source-scoped mark:requested; this hook is the
 * exported primitive that CLAIMS them: one event, one owner
 * (enabled && source === resourceId), replace-on-reselect, no creation/UI/toast
 * inside. Resolution chrome stays host-side.
 *
 * Session-first (not the ask's literal `client:` param): the sanctioned
 * generic-channel subscription is `session.subscribe` (client.bus is
 * audit-forbidden outside the SDK), and chat's reference hook is session-first.
 *
 * Started RED (the hook doesn't exist) and GREEN once the seam lands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, render, fireEvent, within, act } from '@testing-library/react';
import '@testing-library/jest-dom';
import { resourceId } from '@semiont/core';
import type { ResourceDescriptor as SemiontResource, ResourceId } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { usePendingCreation } from '../usePendingCreation';
import { ResourceViewer } from '../../components/resource/ResourceViewer';

vi.mock('../../components/CodeMirrorRenderer', () => ({
  CodeMirrorRenderer: ({ content }: { content: string }) => <div className="codemirror-renderer">{content}</div>,
}));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));

/**
 * Session double with a live subscribe registry. `client.mark.request` is wired
 * to FEED the registry — a faithful mini-bus, so the integration case can run
 * viewer capture → hook claim end to end.
 */
function liveSession() {
  const handlers = new Map<string, Set<(p: unknown) => void>>();
  const fire = (channel: string, payload?: unknown) =>
    handlers.get(channel)?.forEach((h) => h(payload));
  const client = {
    browse: { click: vi.fn(), invalidateAnnotationList: vi.fn() },
    beckon: { hover: vi.fn() },
    mark: {
      delete: vi.fn(),
      request: vi.fn((source: unknown, selector: unknown, motivation: unknown) =>
        fire('mark:requested', { source: String(source), selector, motivation })),
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
  return { session, client, fire };
}

const REQ_A = { source: 'res-a', selector: { type: 'TextPositionSelector', start: 0, end: 5 }, motivation: 'highlighting' };
const REQ_A2 = { source: 'res-a', selector: { type: 'TextPositionSelector', start: 9, end: 12 }, motivation: 'commenting' };

describe('usePendingCreation — the exported creation seam', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keystone: two hooks on one session claim only their own source', () => {
    const { session, fire } = liveSession();
    const a = renderHook(() => usePendingCreation(session, resourceId('res-a'), true));
    const b = renderHook(() => usePendingCreation(session, resourceId('res-b'), true));

    act(() => { fire('mark:requested', REQ_A); });

    expect(a.result.current.pending).toEqual(REQ_A);   // A claims its own…
    expect(b.result.current.pending).toBeNull();       // …B stays null
  });

  it('enabled=false never claims, even for its own source (browse-mode viewers are inert)', () => {
    const { session, fire } = liveSession();
    const { result } = renderHook(() => usePendingCreation(session, resourceId('res-a'), false));

    act(() => { fire('mark:requested', REQ_A); });

    expect(result.current.pending).toBeNull();
  });

  it('a new request for the same resource REPLACES an unresolved pending', () => {
    const { session, fire } = liveSession();
    const { result } = renderHook(() => usePendingCreation(session, resourceId('res-a'), true));

    act(() => { fire('mark:requested', REQ_A); });
    expect(result.current.pending).toEqual(REQ_A);

    act(() => { fire('mark:requested', REQ_A2); });    // user reselected
    expect(result.current.pending).toEqual(REQ_A2);    // replaced, not queued
  });

  it('clearPending resolves to null; session=null is inert', () => {
    const { session, fire } = liveSession();
    const { result } = renderHook(() => usePendingCreation(session, resourceId('res-a'), true));

    act(() => { fire('mark:requested', REQ_A); });
    act(() => { result.current.clearPending(); });
    expect(result.current.pending).toBeNull();

    const inert = renderHook(() => usePendingCreation(null, resourceId('res-a'), true));
    expect(inert.result.current.pending).toBeNull();
  });

  it('integration: viewer selection capture → hook claim, end to end', () => {
    const { session } = liveSession();
    const CONTENT = 'hello world selectme end';
    const resource: SemiontResource & { content: string } = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      '@id': 'res-1' as ResourceId,
      name: 'Doc',
      created: '2024-01-01T00:00:00Z',
      entityTypes: [],
      archived: false,
      representations: [{ mediaType: 'text/plain', byteSize: 10 }],
      content: CONTENT,
    };
    const annotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

    const hook = renderHook(() => usePendingCreation(session, resourceId('res-1'), true));
    const { container } = render(
      <ResourceViewer session={session} resource={resource} annotations={annotations}
        annotateMode={true} onAnnotateModeChange={vi.fn()}
        selectionMotivation="highlighting" onSelectionMotivationChange={vi.fn()}
        showToolbar={false} />,
    );

    // Select "world" (offsets 6..11) and mouseup — the viewer emits mark.request.
    const contentEl = within(container).getByText(CONTENT);
    const range = document.createRange();
    range.setStart(contentEl.firstChild!, 6);
    range.setEnd(contentEl.firstChild!, 11);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(contentEl);

    expect(hook.result.current.pending).not.toBeNull();
    expect(String(hook.result.current.pending!.source)).toBe('res-1');
    expect(hook.result.current.pending!.motivation).toBe('highlighting');
  });
});
