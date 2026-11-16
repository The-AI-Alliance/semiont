/**
 * COMPOSE-IN-MODAL P1 — the compose strategy's form, as a pure step.
 *
 * The from-reference slice of the compose page, lifted: name, save location,
 * entity types (read-only tags when the reference fixed them, picker
 * otherwise), language, and the editor. Deliberately NONE of the page's
 * upload/format/encoding machinery — the fences reference mode already
 * proved are here as absence pins. The draft is CONTROLLED by the host
 * (WIZARD-NAVIGATION D3: stepping Back must not discard typed work), and
 * the evidence display is the host's job (plan A3: no context redux here).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import { ComposeStep, type ComposeDraft } from '../ComposeStep';

// Mock CodeMirrorRenderer to avoid CodeMirror dependencies (same mock the
// compose page's own tests use).
vi.mock('../../CodeMirrorRenderer', () => ({
  CodeMirrorRenderer: ({ content, onChange, editable }: any) => (
    <textarea
      data-testid="code-editor"
      value={content}
      disabled={!editable}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

const T = {
  resourceTitle: 'New resource title',
  resourceTitlePlaceholder: 'Title…',
  saveLocation: 'Save location',
  entityTypes: 'Entity types',
  language: 'Language',
  contentLabel: 'Content',
  back: 'Back',
  createAndLink: 'Create & Link',
  creatingAndLinking: 'Creating…',
};

const DRAFT: ComposeDraft = {
  name: 'Black Hawk',
  storagePath: 'people/black-hawk.md',
  content: 'Sauk leader.',
  entityTypes: [],
  language: 'en',
};

function renderStep(over: Partial<React.ComponentProps<typeof ComposeStep>> = {}) {
  const onDraftChange = vi.fn();
  const onBack = vi.fn();
  const onCompose = vi.fn<(p: unknown) => Promise<void>>().mockResolvedValue(undefined);
  const utils = render(
    <ComposeStep
      draft={DRAFT}
      onDraftChange={onDraftChange}
      referenceEntityTypes={['Person']}
      entityTypeOptions={['Person', 'Topic', 'Location']}
      showLineNumbers={false}
      hoverDelayMs={300}
      onBack={onBack}
      onCompose={onCompose}
      translations={T}
      {...over}
    />,
  );
  return { ...utils, onDraftChange, onBack, onCompose };
}

describe('ComposeStep — the from-reference slice, and nothing else', () => {
  it('renders the draft: name, save location, content, language', () => {
    renderStep();
    expect(screen.getByLabelText(T.resourceTitle)).toHaveValue('Black Hawk');
    expect(screen.getByLabelText(T.saveLocation)).toHaveValue('people/black-hawk.md');
    expect(screen.getByTestId('code-editor')).toHaveValue('Sauk leader.');
    expect(screen.getByLabelText(T.language)).toBeInTheDocument();
  });

  it('edits flow through onDraftChange — the host owns the draft (D3)', () => {
    const { onDraftChange } = renderStep();
    fireEvent.change(screen.getByLabelText(T.resourceTitle), { target: { value: 'Black Hawk (Sauk)' } });
    expect(onDraftChange).toHaveBeenCalledWith({ name: 'Black Hawk (Sauk)' });
    fireEvent.change(screen.getByTestId('code-editor'), { target: { value: 'A Sauk leader.' } });
    expect(onDraftChange).toHaveBeenCalledWith({ content: 'A Sauk leader.' });
  });

  it('reference-fixed entity types render as read-only tags, not a picker (D6)', () => {
    renderStep(); // referenceEntityTypes: ['Person']
    expect(screen.getByText('Person')).toBeInTheDocument();
    // No toggling: the types were chosen when the reference was created.
    expect(screen.queryByRole('button', { name: /Person/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Topic/ })).not.toBeInTheDocument();
  });

  it('an empty reference set falls back to the picker over the owner-supplied options (D6)', () => {
    const { onDraftChange } = renderStep({ referenceEntityTypes: [] });
    const topic = screen.getByRole('button', { name: /Topic/ });
    fireEvent.click(topic);
    expect(onDraftChange).toHaveBeenCalledWith({ entityTypes: ['Topic'] });
  });

  it('carries NONE of the page-only machinery: no upload, no format, no encoding', () => {
    const { container } = renderStep();
    expect(container.querySelector('.semiont-form__upload-dropzone')).toBeNull();
    expect(container.querySelector('.semiont-form__content-source-toggle')).toBeNull();
    expect(container.querySelector('#format-select')).toBeNull();
    expect(container.querySelector('#charset-select')).toBeNull();
  });

  it('renders no context of its own — the evidence is host-stacked (A3)', () => {
    const { container } = renderStep();
    expect(container.querySelector('.semiont-gather-pane')).toBeNull();
    expect(container.querySelector('.semiont-gather__outer')).toBeNull();
  });

  it('submit emits the full params with the file:// prefix applied at the seam', async () => {
    const { onCompose } = renderStep({ referenceEntityTypes: ['Person'] });
    fireEvent.click(screen.getByRole('button', { name: T.createAndLink }));
    await waitFor(() => expect(onCompose).toHaveBeenCalledTimes(1));
    expect(onCompose).toHaveBeenCalledWith({
      name: 'Black Hawk',
      storagePath: 'file://people/black-hawk.md',
      content: 'Sauk leader.',
      entityTypes: ['Person'],
      language: 'en',
    });
  });

  it('the footer is a wizard footer: Back + Create, pending while in flight, re-enabled on rejection (A4)', async () => {
    let reject!: (e: Error) => void;
    const onCompose = vi.fn(() => new Promise<void>((_, r) => { reject = r; }));
    const { container } = renderStep({ onCompose });

    expect(container.querySelector('.semiont-modal__actions--wizard')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: T.createAndLink }));
    expect(await screen.findByRole('button', { name: T.creatingAndLinking })).toBeDisabled();

    reject(new Error('boom'));
    expect(await screen.findByRole('button', { name: T.createAndLink })).toBeEnabled();
  });

  it('Back is the only retreat and dismissal never lives in the footer (A4)', () => {
    const { container, onBack } = renderStep();
    const footerButtons = Array.from(
      container.querySelectorAll('.semiont-modal__actions button'),
    ).map((b) => b.textContent ?? '');
    expect(footerButtons.filter((l) => /cancel|✕/i.test(l))).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: `◀ ${T.back}` }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
