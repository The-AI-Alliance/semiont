import { Component, type ReactElement, type ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LocaleCode } from '@semiont/core';
import { TranslationProvider, useTranslations } from '../TranslationContext';

const ITEMS = '{count, plural, =1 {# item} other {# items}}';

vi.mock('../../../translations/en.json', () => ({
  default: {
    Plurals: {
      plain: 'Search',
      leading: '{count, plural, =1 {# item} other {# items}} found',
      shortPrefix: 'Found {count, plural, =1 {# item} other {# items}}',
      // The prefix is longer than the `{count, plural, ` header itself.
      longPrefix: 'The search finished and found {count, plural, =1 {# item} other {# items}}',
      longPrefixWithParam:
        'The search finished and found {count, plural, =1 {# item} other {# items}} in {{scope}}',
      keyword: 'Found {count, plural, one {# item} other {# items}}',
      several:
        '{files, plural, one {# file} other {# files}} in {folders, plural, one {# folder} other {# folders}}',
      paramInBranch: '{count, plural, one {# item in {{scope}}} other {# items in {{scope}}}}',
    },
  },
}));

vi.mock('../../../translations/pl.json', () => ({
  default: {
    Plurals: {
      plain: 'Szukaj',
      keyword: 'Znaleziono {count, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}',
    },
  },
}));

vi.mock('../../../translations/ja.json', () => {
  throw new Error('ja.json cannot be loaded');
});

function Message({ id, params }: { id: string; params?: Record<string, unknown> }) {
  const t = useTranslations('Plurals');
  return <div data-testid="message">{t(id, params)}</div>;
}

class Boundary extends Component<{ children: ReactNode }, { failure: Error | null }> {
  override state: { failure: Error | null } = { failure: null };

  static getDerivedStateFromError(failure: Error) {
    return { failure };
  }

  override render() {
    return this.state.failure
      ? <div data-testid="failure">{this.state.failure.message}</div>
      : this.props.children;
  }
}

const inLocale = (locale: LocaleCode) => (message: ReactElement) =>
  <TranslationProvider locale={locale}>{message}</TranslationProvider>;

async function translate(
  wrap: (message: ReactElement) => ReactElement,
  id: string,
  params?: Record<string, unknown>,
): Promise<string | null> {
  const { unmount } = render(wrap(<Message id={id} params={params} />));
  const text = (await screen.findByTestId('message')).textContent;
  unmount();
  return text;
}

afterEach(() => vi.restoreAllMocks());

describe('the locale manager looks a translation up', () => {
  const english = inLocale('en');

  it('returns a string as written when no params are passed', async () => {
    expect(await translate(english, 'plain')).toBe('Search');
    expect(await translate(english, 'longPrefixWithParam'))
      .toBe('The search finished and found {count, plural, =1 {# item} other {# items}} in {{scope}}');
  });

  it('returns the namespaced key for a missing translation', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(await translate(english, 'missing')).toBe('Plurals.missing');
    expect(await translate(english, 'missing', { count: 1 })).toBe('Plurals.missing');
  });

  it('warns of a missing translation, naming the key and the locale', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await translate(english, 'missing');
    await translate(inLocale('pl'), 'missing');

    expect(warn).toHaveBeenCalledWith('Translation not found for Plurals.missing in locale en');
    expect(warn).toHaveBeenCalledWith('Translation not found for Plurals.missing in locale pl');
  });
});

describe('the locale manager interpolates', () => {
  const english = inLocale('en');

  it('resolves a plural at the start of the string', async () => {
    expect(await translate(english, 'leading', { count: 1 })).toBe('1 item found');
    expect(await translate(english, 'leading', { count: 3 })).toBe('3 items found');
  });

  it('resolves a plural after a short prefix', async () => {
    expect(await translate(english, 'shortPrefix', { count: 1 })).toBe('Found 1 item');
    expect(await translate(english, 'shortPrefix', { count: 3 })).toBe('Found 3 items');
  });

  it('resolves a plural after a prefix longer than its own header', async () => {
    expect(await translate(english, 'longPrefix', { count: 1 })).toBe('The search finished and found 1 item');
    expect(await translate(english, 'longPrefix', { count: 3 })).toBe('The search finished and found 3 items');
  });

  it('resolves a mid-sentence plural followed by a {{param}}', async () => {
    expect(await translate(english, 'longPrefixWithParam', { count: 3, scope: 'Drafts' }))
      .toBe('The search finished and found 3 items in Drafts');
  });

  it('never renders the plural syntax itself', async () => {
    for (const id of ['leading', 'shortPrefix', 'longPrefix', 'longPrefixWithParam']) {
      expect(await translate(english, id, { count: 2, scope: 'Drafts' })).not.toContain(ITEMS);
    }
  });

  it('selects a plural branch by its category keyword', async () => {
    expect(await translate(english, 'keyword', { count: 1 })).toBe('Found 1 item');
    expect(await translate(english, 'keyword', { count: 3 })).toBe('Found 3 items');
  });

  it('resolves every plural in the string', async () => {
    expect(await translate(english, 'several', { files: 2, folders: 1 })).toBe('2 files in 1 folder');
  });

  it('substitutes a {{param}} written inside a plural branch', async () => {
    expect(await translate(english, 'paramInBranch', { count: 1, scope: 'Drafts' })).toBe('1 item in Drafts');
    expect(await translate(english, 'paramInBranch', { count: 2, scope: 'Drafts' })).toBe('2 items in Drafts');
  });

  it('pluralizes by the rules of its locale', async () => {
    expect(await translate(inLocale('pl'), 'keyword', { count: 1 })).toBe('Znaleziono 1 plik');
    expect(await translate(inLocale('pl'), 'keyword', { count: 3 })).toBe('Znaleziono 3 pliki');
    expect(await translate(inLocale('pl'), 'keyword', { count: 5 })).toBe('Znaleziono 5 plików');
  });
});

describe('TranslationProvider with a locale serves that locale and no other', () => {
  it('shows the loading component, not its children, until the translations are loaded', async () => {
    render(
      <TranslationProvider locale="pl" loadingComponent={<div data-testid="loading" />}>
        <Message id="plain" />
      </TranslationProvider>,
    );

    expect(screen.getByTestId('loading')).toBeInTheDocument();
    expect(screen.queryByTestId('message')).not.toBeInTheDocument();

    expect(await screen.findByTestId('message')).toHaveTextContent('Szukaj');
    expect(screen.queryByTestId('loading')).not.toBeInTheDocument();
  });

  it('shows the loading component, not the previous locale, while a new locale loads', async () => {
    const tree = (locale: LocaleCode) => (
      <TranslationProvider locale={locale} loadingComponent={<div data-testid="loading" />}>
        <Message id="plain" />
      </TranslationProvider>
    );
    const { rerender } = render(tree('pl'));
    expect(await screen.findByTestId('message')).toHaveTextContent('Szukaj');

    rerender(tree('en'));

    expect(screen.queryByText('Szukaj')).not.toBeInTheDocument();
    expect(await screen.findByText('Search')).toBeInTheDocument();
  });

  it('fails when the translations cannot be loaded, serving no other language in their place', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <Boundary>
        <TranslationProvider locale="ja">
          <Message id="plain" />
        </TranslationProvider>
      </Boundary>,
    );

    expect(await screen.findByTestId('failure')).toHaveTextContent('Failed to load translations for locale: ja');
    expect(screen.queryByTestId('message')).not.toBeInTheDocument();
  });
});
