/**
 * SearchModal's search box: it shows what is typed and searches for it as
 * typed, and it opens empty after it was closed with a query in it. The real
 * HeadlessUI Dialog is rendered, as in the keyboard and accessibility suites:
 * closing and opening again is its transition.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '@testing-library/jest-dom';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils';
import { SearchModal } from '../SearchModal';
import { matchResourcesMock, resetSearch, searchTranslations } from './search-modal-harness';

vi.mock('../../../session/SemiontProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../session/SemiontProvider')>();
  const { searchBrowser } = await import('./search-modal-harness');
  return { ...actual, useSemiont: () => searchBrowser };
});

const box = () => screen.getByRole('textbox', { name: searchTranslations.title });

describe('SearchModal — the search box', () => {
  beforeEach(() => {
    resetSearch();
  });

  it('shows what is typed, and searches for it as typed', async () => {
    renderWithProviders(
      <SearchModal isOpen onClose={vi.fn()} onNavigate={vi.fn()} translations={searchTranslations} />,
    );

    fireEvent.change(box(), { target: { value: 'test@#$%^&*()' } });

    expect(box()).toHaveValue('test@#$%^&*()');
    await waitFor(
      () => expect(matchResourcesMock).toHaveBeenCalledWith('test@#$%^&*()', { limit: 5 }),
      { timeout: 1500 },
    );
  });

  it('opens empty after it was closed with a query in it', async () => {
    const props = { onClose: vi.fn(), onNavigate: vi.fn(), translations: searchTranslations };
    const { rerender } = renderWithProviders(<SearchModal isOpen {...props} />);
    fireEvent.change(box(), { target: { value: 'marathon' } });
    expect(box()).toHaveValue('marathon');

    rerender(<SearchModal isOpen={false} {...props} />);
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: searchTranslations.title })).not.toBeInTheDocument(),
    );
    rerender(<SearchModal isOpen {...props} />);

    expect(box()).toHaveValue('');
    await waitFor(() => expect(screen.getByText(searchTranslations.startTyping)).toBeInTheDocument(), {
      timeout: 1500,
    });
  });
});
