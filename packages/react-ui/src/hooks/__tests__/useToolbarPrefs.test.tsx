/**
 * TOOLBAR-PREFS-AS-PROPS Phase 3 — the POLICY layer.
 *
 * useToolbarPrefs() owns one shared prefs state, persists it to the historical
 * localStorage keys, and feeds the same values/callbacks to every viewer it
 * composes — today's Semiont Browser UX (global toolbar, persisted), relocated
 * from inside the components to a visible page-layer hook.
 *
 * Started RED (the hook does not exist) and GREEN once Phase 3 lands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, within, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import type { ResourceDescriptor as SemiontResource, ResourceId } from '@semiont/core';
import { ResourceViewer } from '../../components/resource/ResourceViewer';
import { useToolbarPrefs } from '../useToolbarPrefs';

vi.mock('../../components/CodeMirrorRenderer', () => ({ CodeMirrorRenderer: () => <div>cm-mock</div> }));
vi.mock('react-markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }));
vi.mock('remark-gfm', () => ({ default: () => ({}) }));

const resource: SemiontResource & { content: string } = {
  '@context': 'https://www.w3.org/ns/activitystreams',
  '@id': 'res-1' as ResourceId,
  name: 'Doc',
  created: '2024-01-01T00:00:00Z',
  entityTypes: [],
  archived: false,
  representations: [{ mediaType: 'text/plain', byteSize: 10 }],
  content: 'Policy content.',
};
const annotations = { highlights: [], references: [], assessments: [], comments: [], tags: [] };

function fakeSession(): SemiontSession {
  return {
    client: {
      browse: { click: vi.fn(), invalidateAnnotationList: vi.fn() },
      beckon: { hover: vi.fn() },
      mark: { delete: vi.fn(), request: vi.fn() },
    },
    subscribe: () => () => {},
  } as unknown as SemiontSession;
}

/** Two viewers composed under ONE useToolbarPrefs — the Browser-parity shape. */
function TwoViewers({ session }: { session: SemiontSession }) {
  const prefs = useToolbarPrefs();
  const controlled = {
    annotateMode: prefs.annotateMode,
    onAnnotateModeChange: prefs.setAnnotateMode,
    clickAction: prefs.clickAction,
    onClickActionChange: prefs.setClickAction,
    selectionMotivation: prefs.selectionMotivation,
    onSelectionMotivationChange: prefs.setSelectionMotivation,
    shape: prefs.shape,
    onShapeChange: prefs.setShape,
  };
  return (
    <>
      <div data-testid="v1"><ResourceViewer session={session} resource={resource} annotations={annotations} {...controlled} /></div>
      <div data-testid="v2"><ResourceViewer session={session} resource={resource} annotations={annotations} {...controlled} /></div>
    </>
  );
}

const isAnnotate = (c: HTMLElement) => !!c.querySelector('.semiont-annotate-view');

async function pickMode(container: HTMLElement, option: 'Browse' | 'Annotate') {
  const trigger = within(container).getByLabelText('Mode');
  fireEvent.mouseEnter(trigger.parentElement!);
  await waitFor(() => {
    const menu = within(container).getByRole('menu');
    fireEvent.click(within(menu).getByText(option));
  });
}

describe('useToolbarPrefs — the policy layer (Browser parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('two viewers under one hook stay in lockstep: one Mode click flips both', async () => {
    const { getByTestId } = render(<TwoViewers session={fakeSession()} />);
    const v1 = getByTestId('v1');
    const v2 = getByTestId('v2');
    expect(isAnnotate(v1)).toBe(false);
    expect(isAnnotate(v2)).toBe(false);

    await pickMode(v1, 'Annotate');

    await waitFor(() => {
      expect(isAnnotate(v1)).toBe(true);   // the host (hook) applied it…
      expect(isAnnotate(v2)).toBe(true);   // …to every composed viewer
    });
  });

  it('a change survives a remount via the historical localStorage keys', async () => {
    const session = fakeSession();
    const first = render(<TwoViewers session={session} />);
    await pickMode(first.getByTestId('v1'), 'Annotate');
    await waitFor(() => expect(isAnnotate(first.getByTestId('v1'))).toBe(true));
    expect(localStorage.getItem('annotateMode')).toBe('true'); // persisted by the POLICY layer
    first.unmount();

    const second = render(<TwoViewers session={session} />);
    expect(isAnnotate(second.getByTestId('v1'))).toBe(true);   // restored on remount
  });

  it('initializes from existing keys (users’ saved prefs carry over)', () => {
    localStorage.setItem('semiont-toolbar-click', 'follow');
    const { getByTestId } = render(<TwoViewers session={fakeSession()} />);
    const bar = getByTestId('v1').querySelector('.semiont-annotate-toolbar') as HTMLElement;
    expect(within(bar).getByText('Follow')).toBeInTheDocument();
  });
});
