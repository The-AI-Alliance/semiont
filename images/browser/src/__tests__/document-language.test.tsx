/**
 * `<html lang>` and `<html dir>` follow the route's locale (WCAG 3.1.1
 * Language of Page). The route picks the i18next language, and the document
 * element carries whichever language i18next is rendering.
 *
 * The router, react-i18next and the Browser's i18next instance are the real
 * ones. Only the edges are replaced: the lazy pages are stand-ins, and the
 * locale bundles come from memory instead of `/messages/<code>.json`.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.unmock('react-router');
vi.unmock('react-i18next');

vi.mock('i18next-http-backend', () => ({
  default: {
    type: 'backend',
    read: (_language: string, _namespace: string, callback: (error: null, bundle: object) => void) =>
      callback(null, {}),
  },
}));

vi.mock('@/app/[locale]/layout', async () => {
  const { Outlet } = await import('react-router');
  return { default: () => <Outlet /> };
});

vi.mock('@/app/[locale]/page', async () => {
  const { Link } = await import('react-router');
  return { default: () => <Link to="/fr">fr</Link> };
});

import App from '../App';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('document language', () => {
  it.each([
    ['ar', 'rtl'],
    ['he', 'rtl'],
    ['fa', 'rtl'],
    ['en', 'ltr'],
    ['ja', 'ltr'],
  ])('/%s names its language on <html> and reads %s', async (locale, direction) => {
    renderAt(`/${locale}`);

    await waitFor(() => expect(document.documentElement.lang).toBe(locale));
    expect(document.documentElement.dir).toBe(direction);
  });

  it('follows the route when the locale changes', async () => {
    renderAt('/ar');
    await waitFor(() => expect(document.documentElement.lang).toBe('ar'));
    expect(document.documentElement.dir).toBe('rtl');

    fireEvent.click(await screen.findByRole('link', { name: 'fr' }));

    await waitFor(() => expect(document.documentElement.lang).toBe('fr'));
    expect(document.documentElement.dir).toBe('ltr');
  });
});
