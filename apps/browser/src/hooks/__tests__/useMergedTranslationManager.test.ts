/**
 * The Browser's translation manager resolves a key from the active i18next
 * bundle and interpolates it with react-ui's `interpolateTranslation`. The
 * pipeline's own cases are tested where it lives, in react-ui; these pin the
 * hook to it, so a string renders the same here as under react-ui's built-in
 * managers.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMergedTranslationManager } from '../useMergedTranslationManager';

const BUNDLES: Record<string, Record<string, Record<string, string>>> = {
  en: {
    Search: {
      title: 'Search',
      mode: 'Using {{mode}} mode',
      // The prefix is longer than the `{count, plural, ` header itself.
      found: 'The search finished and found {count, plural, =1 {# item} other {# items}} in {{scope}}',
      files: '{count, plural, one {# file} other {# files}}',
    },
  },
  pl: {
    Search: {
      files: '{count, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}',
    },
  },
};

const active = vi.hoisted(() => ({ language: 'en' }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: {
      language: active.language,
      getResourceBundle: (language: string) => BUNDLES[language],
    },
  }),
}));

function manager() {
  return renderHook(() => useMergedTranslationManager()).result.current;
}

describe('useMergedTranslationManager', () => {
  afterEach(() => {
    active.language = 'en';
  });

  it('returns a string with no params as written', () => {
    expect(manager().t('Search', 'title')).toBe('Search');
  });

  it('substitutes {{param}} placeholders', () => {
    expect(manager().t('Search', 'mode', { mode: 'Light' })).toBe('Using Light mode');
  });

  it('resolves a mid-sentence plural and a {{param}} in one string', () => {
    expect(manager().t('Search', 'found', { count: 1, scope: 'Drafts' }))
      .toBe('The search finished and found 1 item in Drafts');
    expect(manager().t('Search', 'found', { count: 3, scope: 'Drafts' }))
      .toBe('The search finished and found 3 items in Drafts');
  });

  it('selects a plural branch by its category keyword', () => {
    expect(manager().t('Search', 'files', { count: 1 })).toBe('1 file');
    expect(manager().t('Search', 'files', { count: 3 })).toBe('3 files');
  });

  it('pluralizes by the rules of the active language', () => {
    active.language = 'pl';

    expect(manager().t('Search', 'files', { count: 1 })).toBe('1 plik');
    expect(manager().t('Search', 'files', { count: 3 })).toBe('3 pliki');
    expect(manager().t('Search', 'files', { count: 5 })).toBe('5 plików');
  });

  it('returns the namespaced key for a missing translation', () => {
    expect(manager().t('Search', 'missing')).toBe('Search.missing');
    expect(manager().t('Unknown', 'title')).toBe('Unknown.title');
  });
});
