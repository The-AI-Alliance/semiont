/**
 * AssistShell (#7) — the shared assist chrome. Pins the net behavior that
 * holds across the isAssisting-prop relocation: the form/progress switch and
 * the dismiss policy (dismiss is offered only once the assist is no longer
 * running — the SHELL owns that policy; AssistProgress just renders whatever
 * callback it is handed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { AssistShell } from '../AssistShell';

const progress = { stage: 'analyzing', percentage: 50 };

/** AssistProgress requires a full translation set; the shell just passes it through. */
const TR = { cancel: 'tr.cancel', inProgress: 'tr.inProgress', complete: 'tr.complete',
  failed: 'tr.failed', close: 'tr.close', paramsTitle: 'tr.paramsTitle',
  processing: (l: string) => `tr.processing(${l})` };

describe('AssistShell', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the form when there is no progress, the progress when there is', () => {
    const { rerender } = render(
      <AssistShell assistType="tag" title="Annotate Tags" isAssisting={false} progress={null}
        form={<button type="button">the form</button>} progressProps={{ translations: TR }} />,
    );
    expect(screen.getByText('the form')).toBeInTheDocument();
    rerender(
      <AssistShell assistType="tag" title="Annotate Tags" isAssisting={true} progress={progress}
        form={<button type="button">the form</button>} progressProps={{ translations: TR }} />,
    );
    expect(screen.queryByText('the form')).not.toBeInTheDocument();
    expect(screen.getByText('tr.inProgress')).toBeInTheDocument();
  });

  it('withholds dismiss while assisting, offers it once terminal', async () => {
    const onDismiss = vi.fn();
    const props = {
      assistType: 'highlight', title: 'Annotate Highlights', progress,
      form: <span>form</span>,
      progressProps: { onDismiss, translations: { ...TR, close: 'Close' } },
    };
    const { rerender } = render(<AssistShell {...props} isAssisting={true} />);
    expect(screen.queryByLabelText('Close')).not.toBeInTheDocument();

    rerender(<AssistShell {...props} isAssisting={false} />);
    await userEvent.click(screen.getByLabelText('Close'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('persists the expand state per assist type', async () => {
    render(
      <AssistShell assistType="reference" title="Annotate References" isAssisting={false} progress={null}
        form={<span>form</span>} progressProps={{ translations: TR }} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Annotate References/ }));
    expect(screen.queryByText('form')).not.toBeInTheDocument();
    expect(localStorage.getItem('assist-section-expanded-reference')).toBe('false');
  });
});
