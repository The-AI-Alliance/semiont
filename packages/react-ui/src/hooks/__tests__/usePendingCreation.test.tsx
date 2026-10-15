/**
 * usePendingCreation, the consuming half of the viewer's capture/policy
 * split.
 *
 * The viewer captures and emits source-scoped mark:requested; this hook is the
 * exported primitive that CLAIMS them: one event, one owner
 * (enabled && source === resourceId), replace-on-reselect, no creation/UI/toast
 * inside. Resolution chrome stays host-side.
 *
 * Session-first, not a `client:` param: like react-ui's other event hooks it
 * reads its channel on the session's client, and chat's reference hook is
 * session-first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, fireEvent, within, act } from '@testing-library/react';
import { renderInEnglish } from '../../test-utils';
import '@testing-library/jest-dom';
import { resourceId, EventBus } from '@semiont/core';
import type { EventMap, ResourceDescriptor as SemiontResource, ResourceId } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { usePendingCreation } from '../usePendingCreation';
import { ResourceViewer } from '../../components/resource/ResourceViewer';

vi.mock('../../components/CodeMirrorRenderer', () => ({
  CodeMirrorRenderer: ({ content }: { content: string }) => <div className="semiont-codemirror">{content}</div>,
}));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));

type MarkRequested = EventMap['mark:requested'];

/**
 * Session double over a real bus. `client.mark.request` is wired to emit on
 * it, so the integration case can run viewer capture → hook claim end to end.
 */
function liveSession() {
  const bus = new EventBus();
  const fire = (channel: 'mark:requested', payload: MarkRequested) => bus.emit(channel, payload);
  const client = {
    bus,
    browse: { click: vi.fn(), invalidateAnnotationList: vi.fn() },
    beckon: { hover: vi.fn() },
    mark: {
      delete: vi.fn(),
      request: vi.fn((source: ResourceId, selector: MarkRequested['selector'], motivation: MarkRequested['motivation']) =>
        fire('mark:requested', { source, selector, motivation })),
    },
  };
  const session = { client } as unknown as SemiontSession;
  return { session, client, fire };
}

const REQ_A: MarkRequested = { source: resourceId('res-a'), selector: { type: 'TextPositionSelector', start: 0, end: 5 }, motivation: 'highlighting' };
const REQ_A2: MarkRequested = { source: resourceId('res-a'), selector: { type: 'TextPositionSelector', start: 9, end: 12 }, motivation: 'commenting' };

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
    const { container } = renderInEnglish(
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
