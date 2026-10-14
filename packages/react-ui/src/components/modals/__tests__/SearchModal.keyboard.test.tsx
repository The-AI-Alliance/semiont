/**
 * SearchModal from the keyboard: the arrow keys move one selection through
 * the results and wrap at either end, Enter opens the selected result, and
 * Escape closes the modal. The real HeadlessUI Dialog is rendered: Escape is
 * its behaviour, not the modal's own.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom';
import { screen, fireEvent, waitFor } from '@testing-library/react';
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

const SELECTED = 'semiont-search-modal__result--selected';

/** The row of the result named `name`. */
const row = (name: string) => screen.getByText(name).closest('button')!;

/** Open the modal, search, and answer with one result per name. */
async function openWith(...names: string[]) {
  const onClose = vi.fn();
  const onNavigate = vi.fn();
  renderWithProviders(
    <SearchModal isOpen onClose={onClose} onNavigate={onNavigate} translations={searchTranslations} />,
  );
  const input = screen.getByPlaceholderText(searchTranslations.placeholder);
  fireEvent.change(input, { target: { value: 'doc' } });
  await waitFor(() => expect(matchResourcesMock).toHaveBeenCalled(), { timeout: 1500 });
  setBrowseResults(names.map((name, index) => buildResource(`res-${index + 1}`, name)));
  if (names.length > 0) {
    await waitFor(() => expect(screen.getByText(names.at(-1)!)).toBeInTheDocument(), { timeout: 1500 });
  } else {
    await waitFor(() => expect(screen.getByText(/No results found for/)).toBeInTheDocument(), { timeout: 1500 });
  }
  return { input, onClose, onNavigate };
}

describe('SearchModal — keyboard', () => {
  beforeEach(() => {
    resetSearch();
  });

  it('selects the first result when the results arrive', async () => {
    await openWith('First', 'Second', 'Third');

    expect(row('First')).toHaveClass(SELECTED);
    expect(row('Second')).not.toHaveClass(SELECTED);
  });

  it('moves the selection down with ArrowDown, and wraps past the last result', async () => {
    const { input } = await openWith('First', 'Second', 'Third');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(row('Second')).toHaveClass(SELECTED);
    expect(row('First')).not.toHaveClass(SELECTED);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(row('First')).toHaveClass(SELECTED);
  });

  it('moves the selection up with ArrowUp, and wraps before the first result', async () => {
    const { input } = await openWith('First', 'Second', 'Third');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(row('Third')).toHaveClass(SELECTED);
  });

  it('keeps the arrow keys from moving the cursor in the search box', async () => {
    const { input } = await openWith('First', 'Second');

    // `fireEvent` answers false when a handler prevented the default.
    expect(fireEvent.keyDown(input, { key: 'ArrowDown' })).toBe(false);
    expect(fireEvent.keyDown(input, { key: 'ArrowUp' })).toBe(false);
  });

  it('opens the selected result with Enter, and closes', async () => {
    const { input, onClose, onNavigate } = await openWith('First', 'Second', 'Third');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('resource', 'res-2');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens nothing with Enter when there are no results', async () => {
    const { input, onNavigate } = await openWith();

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('closes with Escape', async () => {
    const { input, onClose, onNavigate } = await openWith('First');

    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledOnce();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('moves the same selection with the pointer as with the keys', async () => {
    const { input, onNavigate } = await openWith('First', 'Second', 'Third');

    fireEvent.mouseEnter(row('Third'));
    expect(row('Third')).toHaveClass(SELECTED);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('resource', 'res-3');
  });
});
