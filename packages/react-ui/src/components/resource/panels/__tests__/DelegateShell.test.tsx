/**
 * DelegateShell — the shared delegate-section chrome. Pins the form/progress switch and
 * the dismiss policy (dismiss is offered only once the delegated job has stopped
 * running — the SHELL owns that policy; DelegateProgress just renders whatever
 * callback it is handed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { jobId } from '@semiont/core';
import type { SemiontSession } from '@semiont/sdk';
import { createTestSession } from '@semiont/sdk/testing';
import { DelegateShell } from '../DelegateShell';
import { delegatedJobControls, markJobControls } from '../../../../lib/delegated-job-controls';

const progress = { percentage: 50 };
const noJob = delegatedJobControls(null, null, undefined);

/** DelegateProgress requires a full translation set; the shell just passes it through. */
const TR = {
  cancel: 'tr.cancel',
  cancelling: 'tr.cancelling',
  close: 'tr.close',
  inProgress: 'tr.inProgress',
  message: () => 'tr.code',
  subject: (c: { kind: string; value: string }) => `tr.subject(${c.kind}:${c.value})`,
  paramLabel: (c: string) => `tr.param(${c})`,
};

const sessions: SemiontSession[] = [];

describe('DelegateShell', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const session of sessions.splice(0)) session.dispose();
  });

  it('renders the form when there is no progress, the progress when there is', () => {
    const { rerender } = render(
      <DelegateShell delegateType="tag" title="Annotate Tags" isDelegating={false} progress={null}
        form={<button type="button">the form</button>} controls={noJob} progressProps={{ translations: TR }} />,
    );
    expect(screen.getByText('the form')).toBeInTheDocument();
    rerender(
      <DelegateShell delegateType="tag" title="Annotate Tags" isDelegating={true} progress={progress}
        form={<button type="button">the form</button>} controls={noJob} progressProps={{ translations: TR }} />,
    );
    expect(screen.queryByText('the form')).not.toBeInTheDocument();
    expect(screen.getByText('tr.inProgress')).toBeInTheDocument();
  });

  it('withholds dismiss while delegating, offers it once terminal', async () => {
    const onDismiss = vi.fn();
    const props = {
      delegateType: 'highlight' as const, title: 'Annotate Highlights', progress,
      form: <span>form</span>,
      controls: delegatedJobControls(null, null, onDismiss),
      progressProps: { translations: { ...TR, close: 'Close' } },
    };
    const { rerender } = render(<DelegateShell {...props} isDelegating={true} />);
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();

    rerender(<DelegateShell {...props} isDelegating={false} />);
    await userEvent.click(screen.getByLabelText('Close'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("starts a second job's display live, though the first job's cancel was never answered", async () => {
    const { session, client } = createTestSession();
    sessions.push(session);
    vi.spyOn(client.job, 'cancel').mockReturnValue(new Promise<boolean>(() => {}));
    const running = (job: string) => (
      <DelegateShell delegateType="reference" title="t" isDelegating={true} progress={progress}
        form={null} controls={markJobControls(session, jobId(job))} progressProps={{ translations: TR }} />
    );
    const { rerender } = render(running('job-1'));
    await userEvent.click(screen.getByTestId('semiont-delegate-control'));
    expect(screen.getByTestId('semiont-delegate-control')).toBeDisabled();

    rerender(running('job-2'));
    expect(screen.getByTestId('semiont-delegate-control')).toBeEnabled();
    expect(screen.getByTestId('semiont-delegate-control')).toHaveAccessibleName('tr.cancel');
  });

  it('does not compile when it names no job: a panel cannot leave the control out', () => {
    const elements = [
      // @ts-expect-error no job: the display would follow none, and show no cancel control
      <DelegateShell delegateType="tag" title="t" isDelegating={true} progress={progress}
        form={null} progressProps={{ translations: TR }} />,
      // @ts-expect-error controls written in place, not made from a job
      <DelegateShell controls={{ onCancel: undefined, onDismiss: () => {} }} delegateType="tag" title="t"
        isDelegating={true} progress={progress} form={null} progressProps={{ translations: TR }} />,
      // @ts-expect-error a cancel handed to the display around the job's controls
      <DelegateShell progressProps={{ translations: TR, onCancel: () => {} }} delegateType="tag" title="t"
        isDelegating={true} progress={progress} form={null} controls={noJob} />,
    ];
    expect(elements).toHaveLength(3);
  });

  it('persists the expand state per delegate type', async () => {
    render(
      <DelegateShell delegateType="reference" title="Annotate References" isDelegating={false} progress={null}
        form={<span>form</span>} controls={noJob} progressProps={{ translations: TR }} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Annotate References/ }));
    expect(screen.queryByText('form')).not.toBeInTheDocument();
    expect(localStorage.getItem('delegate-section-expanded-reference')).toBe('false');
  });
});
