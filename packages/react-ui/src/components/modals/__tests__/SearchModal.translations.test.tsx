/**
 * SearchModal shows the strings its host gives it and has none of its own.
 *
 * HeadlessUI's Dialog is replaced with plain elements here: the real one
 * exhausts jsdom's memory, which is why the other SearchModal suites are
 * skipped.
 */
import type { ReactNode } from 'react';
import { describe, it, expect, vi } from 'vitest';
import '@testing-library/jest-dom';
import { screen } from '@testing-library/react';
import { renderWithProviders } from '../../../test-utils';
import { SearchModal } from '../SearchModal';

vi.mock('@headlessui/react', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>,
  DialogPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Transition: ({ show, children }: { show: boolean; children: ReactNode }) => (show ? <>{children}</> : null),
  TransitionChild: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const translations = {
  placeholder: '[placeholder]',
  searching: '[searching]',
  noResults: '[noResults]',
  startTyping: '[startTyping]',
  navigate: '[navigate]',
  select: '[select]',
  close: '[close]',
  enter: '[enter]',
  esc: '[esc]',
};

function open() {
  return renderWithProviders(
    <SearchModal isOpen onClose={vi.fn()} onNavigate={vi.fn()} translations={translations} />,
  );
}

describe('SearchModal translations', () => {
  it('shows the strings it is given', () => {
    open();

    expect(screen.getByPlaceholderText('[placeholder]')).toBeInTheDocument();
    for (const shown of ['[startTyping]', '[navigate]', '[select]', '[close]', '[enter]']) {
      expect(screen.getByText(shown)).toBeInTheDocument();
    }
  });

  it('labels the escape key with the string it is given, in both places it shows it', () => {
    open();

    expect(screen.getAllByText('[esc]')).toHaveLength(2);
    expect(screen.queryByText('Esc')).not.toBeInTheDocument();
  });

  it('takes every string from its host', () => {
    const { esc: _esc, ...withoutEsc } = translations;

    const elements = [
      // @ts-expect-error no translations
      <SearchModal isOpen onClose={vi.fn()} onNavigate={vi.fn()} />,
      // @ts-expect-error a string is missing
      <SearchModal isOpen onClose={vi.fn()} onNavigate={vi.fn()} translations={withoutEsc} />,
    ];

    expect(elements).toHaveLength(2);
  });
});
