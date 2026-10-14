/**
 * SearchModal for a person using assistive technology: a modal dialog with a
 * name, a named search box with focus in it when it opens, and nothing
 * axe-core finds wrong, empty or with results. The real HeadlessUI Dialog is
 * rendered: the dialog's role, its modality and its focus are its behaviour,
 * not the modal's own.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { renderWithProviders } from '../../../test-utils';
import { SearchModal } from '../SearchModal';
import {
  buildResource,
  matchResourcesMock,
  resetSearch,
  searchTranslations,
  setBrowseResults,
} from './search-modal-harness';

vi.mock('../../../session/SemiontProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../session/SemiontProvider')>();
  const { searchBrowser } = await import('./search-modal-harness');
  return { ...actual, useSemiont: () => searchBrowser };
});

expect.extend(toHaveNoViolations);

function open() {
  renderWithProviders(
    <SearchModal isOpen onClose={vi.fn()} onNavigate={vi.fn()} translations={searchTranslations} />,
  );
  return screen.getByRole('textbox', { name: searchTranslations.title });
}

/** Search, and answer with one result per name. */
async function search(input: HTMLElement, ...names: string[]) {
  fireEvent.change(input, { target: { value: 'doc' } });
  await waitFor(() => expect(matchResourcesMock).toHaveBeenCalled(), { timeout: 1500 });
  setBrowseResults(names.map((name, index) => buildResource(`res-${index + 1}`, name)));
  await waitFor(() => expect(screen.getByText(names.at(-1)!)).toBeInTheDocument(), { timeout: 1500 });
}

describe('SearchModal — Accessibility', () => {
  beforeEach(() => {
    resetSearch();
  });

  it('is a modal dialog, named by its title', () => {
    open();

    const dialog = screen.getByRole('dialog', { name: searchTranslations.title });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('names its search box', () => {
    expect(open()).toBeInTheDocument();
  });

  it('puts focus in the search box when it opens', async () => {
    const input = open();

    await waitFor(() => expect(input).toHaveFocus());
  });

  it('has no axe violations when it opens', async () => {
    open();

    // The dialog is portalled to the body, outside the render's container.
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('has no axe violations with results shown', async () => {
    const input = open();
    await search(input, 'First', 'Second');

    expect(await axe(document.body)).toHaveNoViolations();
  });
});
