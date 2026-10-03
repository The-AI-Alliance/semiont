import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { TranslationProvider, useTranslations } from '../TranslationContext';

const ITEMS = '{count, plural, =1 {# item} other {# items}}';

vi.mock('../../../translations/en.json', () => ({
  default: {
    Plurals: {
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
      keyword: 'Znaleziono {count, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}',
    },
  },
}));

// Japanese has one plural category, so English strings read by its rules
// would never take their `one` branch.
vi.mock('../../../translations/ja.json', () => {
  throw new Error('ja.json cannot be loaded');
});

function Message({ id, params }: { id: string; params: Record<string, unknown> }) {
  const t = useTranslations('Plurals');
  return <div data-testid="message">{t(id, params)}</div>;
}

async function translate(
  wrap: (message: ReactElement) => ReactElement,
  id: string,
  params: Record<string, unknown>,
): Promise<string | null> {
  const { unmount } = render(wrap(<Message id={id} params={params} />));
  const text = (await screen.findByTestId('message')).textContent;
  unmount();
  return text;
}

// The three places react-ui resolves a built-in translation.
const PATHS: Array<[string, (message: ReactElement) => ReactElement]> = [
  ['useTranslations without a provider', (message) => message],
  ['the default English manager', (message) => <TranslationProvider>{message}</TranslationProvider>],
  ['the locale manager', (message) => <TranslationProvider locale="en">{message}</TranslationProvider>],
];

describe.each(PATHS)('built-in interpolation through %s', (_path, wrap) => {
  it('resolves a plural at the start of the string', async () => {
    expect(await translate(wrap, 'leading', { count: 1 })).toBe('1 item found');
    expect(await translate(wrap, 'leading', { count: 3 })).toBe('3 items found');
  });

  it('resolves a plural after a short prefix', async () => {
    expect(await translate(wrap, 'shortPrefix', { count: 1 })).toBe('Found 1 item');
    expect(await translate(wrap, 'shortPrefix', { count: 3 })).toBe('Found 3 items');
  });

  it('resolves a plural after a prefix longer than its own header', async () => {
    expect(await translate(wrap, 'longPrefix', { count: 1 })).toBe('The search finished and found 1 item');
    expect(await translate(wrap, 'longPrefix', { count: 3 })).toBe('The search finished and found 3 items');
  });

  it('resolves a mid-sentence plural followed by a {{param}}', async () => {
    expect(await translate(wrap, 'longPrefixWithParam', { count: 3, scope: 'Drafts' }))
      .toBe('The search finished and found 3 items in Drafts');
  });

  it('never renders the plural syntax itself', async () => {
    for (const id of ['leading', 'shortPrefix', 'longPrefix', 'longPrefixWithParam']) {
      expect(await translate(wrap, id, { count: 2, scope: 'Drafts' })).not.toContain(ITEMS);
    }
  });

  it('selects a plural branch by its category keyword', async () => {
    expect(await translate(wrap, 'keyword', { count: 1 })).toBe('Found 1 item');
    expect(await translate(wrap, 'keyword', { count: 3 })).toBe('Found 3 items');
  });

  it('resolves every plural in the string', async () => {
    expect(await translate(wrap, 'several', { files: 2, folders: 1 })).toBe('2 files in 1 folder');
  });

  it('substitutes a {{param}} written inside a plural branch', async () => {
    expect(await translate(wrap, 'paramInBranch', { count: 1, scope: 'Drafts' })).toBe('1 item in Drafts');
    expect(await translate(wrap, 'paramInBranch', { count: 2, scope: 'Drafts' })).toBe('2 items in Drafts');
  });
});

describe('the locale manager pluralizes by the language of the strings it serves', () => {
  afterEach(() => vi.restoreAllMocks());

  const inLocale = (locale: string) => (message: ReactElement) =>
    <TranslationProvider locale={locale}>{message}</TranslationProvider>;

  it('uses the locale whose translations it loaded', async () => {
    expect(await translate(inLocale('pl'), 'keyword', { count: 1 })).toBe('Znaleziono 1 plik');
    expect(await translate(inLocale('pl'), 'keyword', { count: 3 })).toBe('Znaleziono 3 pliki');
    expect(await translate(inLocale('pl'), 'keyword', { count: 5 })).toBe('Znaleziono 5 plików');
  });

  it('uses English when it fell back to the English strings', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await translate(inLocale('ja'), 'keyword', { count: 1 })).toBe('Found 1 item');
    expect(await translate(inLocale('ja'), 'keyword', { count: 3 })).toBe('Found 3 items');
  });
});
