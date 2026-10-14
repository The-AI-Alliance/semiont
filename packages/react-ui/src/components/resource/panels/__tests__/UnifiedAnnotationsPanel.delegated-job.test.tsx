/**
 * The delegated job's id goes where its progress goes: to the panel of the
 * delegated motivation, whose cancel control names that job. Every motivation
 * a person can delegate has the control, from the moment the queue has named
 * the job; before that there is none.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderInEnglish } from '../../../../test-utils';
import '@testing-library/jest-dom';
import type { SemiontSession } from '@semiont/sdk';
import { createTestSession } from '@semiont/sdk/testing';
import type { LinkComponentProps, RouteBuilder } from '../../../../contexts/RoutingContext';
import { UnifiedAnnotationsPanel } from '../UnifiedAnnotationsPanel';
import { ANNOTATORS, annotatorKeyForMotivation, type AnnotatorKey } from '../../../../lib/annotation-registry';
import { jobId, resourceId, type JobId, type Motivation } from '@semiont/core';

const TestLink = ({ href, children, ...rest }: LinkComponentProps) => <a href={href} {...rest}>{children}</a>;
const testRoutes: RouteBuilder = { resourceDetail: (id) => `/r/${id}` };

type PanelProps = React.ComponentProps<typeof UnifiedAnnotationsPanel>;

const sessions: SemiontSession[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) session.dispose();
  // The panel restores a resource's last tab from storage, over `initialTab`.
  localStorage.clear();
});

function harness() {
  const { session, client } = createTestSession();
  sessions.push(session);
  const cancel = vi.spyOn(client.job, 'cancel').mockResolvedValue(true);
  return { session, cancel };
}

const delegating = (
  session: SemiontSession,
  motivation: Motivation,
  tab: AnnotatorKey,
  job: JobId | null,
): PanelProps => ({
  session,
  annotations: [],
  annotators: ANNOTATORS,
  annotateMode: true,
  allEntityTypes: [],
  pendingAnnotation: null,
  delegatingMotivation: motivation,
  progress: { percentage: 10 },
  jobId: job,
  resourceId: resourceId('res-1'),
  initialTab: tab,
  Link: TestLink,
  routes: testRoutes,
});

// Every motivation the registry knows is one a person can delegate.
const motivations = Object.values(ANNOTATORS).map(({ motivation }) => {
  const tab = annotatorKeyForMotivation(motivation);
  if (!tab) throw new Error(`the registry names no panel for ${motivation}`);
  return { tab, motivation };
});

describe('UnifiedAnnotationsPanel: the delegated job', () => {
  it.each(motivations)("gives a $motivation job's id to its panel, whose control cancels that job", ({ tab, motivation }) => {
    const { session, cancel } = harness();
    renderInEnglish(<UnifiedAnnotationsPanel {...delegating(session, motivation, tab, jobId('job-1'))} />);

    fireEvent.click(screen.getByTestId('semiont-delegate-control'));
    expect(cancel).toHaveBeenCalledExactlyOnceWith('job-1');
  });

  it.each(motivations)('shows a $motivation job no control before the queue has named it', ({ tab, motivation }) => {
    const { session } = harness();
    renderInEnglish(<UnifiedAnnotationsPanel {...delegating(session, motivation, tab, null)} />);

    // The display is there; only its control is not.
    expect(screen.getByTestId('semiont-delegate-status')).toBeInTheDocument();
    expect(screen.queryByTestId('semiont-delegate-control')).toBeNull();
  });

  it("shows the references panel no control for another motivation's job", () => {
    const { session } = harness();
    renderInEnglish(<UnifiedAnnotationsPanel {...delegating(session, 'highlighting', 'reference', jobId('job-1'))} />);

    expect(screen.queryByTestId('semiont-delegate-control')).toBeNull();
  });
});
