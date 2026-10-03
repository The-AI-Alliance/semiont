/**
 * The routing helpers build every URL under the locale in use. That locale is
 * the route's, or failing that the language i18next is rendering; there is no
 * third answer, so with neither they throw.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.unmock('react-router');
vi.unmock('@/i18n/routing');

const active = vi.hoisted(() => ({ language: undefined as string | undefined }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: active.language } }),
}));

vi.mock('@/i18n/config', async () => {
  const { AVAILABLE_LOCALES } = await vi.importActual<typeof import('@semiont/react-ui')>('@semiont/react-ui');
  return { isSupportedLocale: (locale: string) => (AVAILABLE_LOCALES as readonly string[]).includes(locale) };
});

import { Link, useLocale } from '../routing';

const at = (path: string) => ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/:locale/*" element={children} />
      <Route path="*" element={children} />
    </Routes>
  </MemoryRouter>
);

afterEach(() => {
  active.language = undefined;
  vi.restoreAllMocks();
});

describe('useLocale', () => {
  it("is the route's locale", () => {
    active.language = 'en';

    expect(renderHook(() => useLocale(), { wrapper: at('/fr/know') }).result.current).toBe('fr');
  });

  it("is i18next's language when the route names no supported locale", () => {
    active.language = 'de';

    expect(renderHook(() => useLocale(), { wrapper: at('/') }).result.current).toBe('de');
  });

  it('throws when neither the route nor i18next has one', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => renderHook(() => useLocale(), { wrapper: at('/') }))
      .toThrow('No locale: the route names none and i18next has no language');
  });
});

describe('Link', () => {
  it("prefixes its target with the route's locale", () => {
    active.language = 'en';

    render(<Link to="/know/discover">discover</Link>, { wrapper: at('/fr/know') });

    expect(screen.getByRole('link', { name: 'discover' })).toHaveAttribute('href', '/fr/know/discover');
  });

  it('throws when there is no locale to prefix', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<Link to="/know/discover">discover</Link>, { wrapper: at('/') }))
      .toThrow('No locale: the route names none and i18next has no language');
  });
});
