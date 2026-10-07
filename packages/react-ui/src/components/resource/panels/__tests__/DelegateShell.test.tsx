/**
 * DelegateShell — the shared delegate-section chrome. Pins the form/progress switch and
 * the dismiss policy (dismiss is offered only once the delegated job has stopped
 * running — the SHELL owns that policy; DelegateProgress just renders whatever
 * callback it is handed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { DelegateShell } from '../DelegateShell';

const progress = { percentage: 50 };

/** DelegateProgress requires a full translation set; the shell just passes it through. */
const TR = {
  cancel: 'tr.cancel',
  close: 'tr.close',
  inProgress: 'tr.inProgress',
  message: () => 'tr.code',
  subject: (c: { kind: string; value: string }) => `tr.subject(${c.kind}:${c.value})`,
  paramLabel: (c: string) => `tr.param(${c})`,
};

describe('DelegateShell', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the form when there is no progress, the progress when there is', () => {
    const { rerender } = render(
      <DelegateShell delegateType="tag" title="Annotate Tags" isDelegating={false} progress={null}
        form={<button type="button">the form</button>} progressProps={{ translations: TR }} />,
    );
    expect(screen.getByText('the form')).toBeInTheDocument();
    rerender(
      <DelegateShell delegateType="tag" title="Annotate Tags" isDelegating={true} progress={progress}
        form={<button type="button">the form</button>} progressProps={{ translations: TR }} />,
    );
    expect(screen.queryByText('the form')).not.toBeInTheDocument();
    expect(screen.getByText('tr.inProgress')).toBeInTheDocument();
  });

  it('withholds dismiss while delegating, offers it once terminal', async () => {
    const onDismiss = vi.fn();
    const props = {
      delegateType: 'highlight' as const, title: 'Annotate Highlights', progress,
      form: <span>form</span>,
      progressProps: { onDismiss, translations: { ...TR, close: 'Close' } },
    };
    const { rerender } = render(<DelegateShell {...props} isDelegating={true} />);
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();

    rerender(<DelegateShell {...props} isDelegating={false} />);
    await userEvent.click(screen.getByLabelText('Close'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('persists the expand state per delegate type', async () => {
    render(
      <DelegateShell delegateType="reference" title="Annotate References" isDelegating={false} progress={null}
        form={<span>form</span>} progressProps={{ translations: TR }} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Annotate References/ }));
    expect(screen.queryByText('form')).not.toBeInTheDocument();
    expect(localStorage.getItem('delegate-section-expanded-reference')).toBe('false');
  });
});
