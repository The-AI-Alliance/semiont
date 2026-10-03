/**
 * The Browser renders in the locale its URL names and assumes no other. A URL
 * that names no usable locale gets the language picker; a locale whose
 * translations cannot be loaded is an error; i18next has no fallback language.
 *
 * The router, react-i18next and the Browser's i18next instance are the real
 * ones. Only the edges are replaced: the lazy pages are stand-ins, and the
 * locale bundles come from memory instead of `/messages/<code>.json`.
 *
 * The i18next instance is one for the file, so the tests under "a supported
 * locale" run in order: the first starts with no language at all.
 */
import { Component, type ReactNode } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AVAILABLE_LOCALES } from '@semiont/react-ui';

vi.unmock('react-router');
vi.unmock('react-i18next');

type Deliver = (error: Error | null, bundle: object | false) => void;

const backend = vi.hoisted(() => {
  const held = new Map<string, () => void>();
  return {
    requested: [] as string[],
    hold: new Set<string>(),
    fail: new Set<string>(),
    release(language: string) {
      const deliver = held.get(language);
      if (!deliver) throw new Error(`nothing is held for ${language}`);
      deliver();
    },
    read(language: string, deliver: (error: Error | null, bundle: object | false) => void) {
      this.requested.push(language);
      if (this.fail.has(language)) {
        deliver(new Error(`no bundle for ${language}`), false);
        return;
      }
      const bundle = () => deliver(null, {});
      if (this.hold.has(language)) held.set(language, bundle);
      else bundle();
    },
  };
});

vi.mock('i18next-http-backend', () => ({
  default: {
    type: 'backend',
    read: (language: string, _namespace: string, deliver: Deliver) => backend.read(language, deliver),
  },
}));

vi.mock('@/app/[locale]/layout', async () => {
  const { Outlet } = await import('react-router');
  return { default: () => <Outlet /> };
});

vi.mock('@/app/[locale]/page', async () => {
  const { Link, useParams } = await import('react-router');
  return {
    default: () => (
      <div data-testid="home-page">
        {useParams().locale}
        <Link to="/ja">ja</Link>
        <Link to="/th">th</Link>
      </div>
    ),
  };
});

import App from '../App';
import i18n from '../i18n/config';

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

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Boundary>
        <App />
      </Boundary>
    </MemoryRouter>,
  );
}

function browserLanguageIs(language: string) {
  vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(language);
}

function pickerLinks(): HTMLAnchorElement[] {
  return screen.getAllByRole<HTMLAnchorElement>('link');
}

afterEach(() => vi.restoreAllMocks());

describe('i18next', () => {
  it('has no fallback language', () => {
    expect(i18n.options.fallbackLng).toBe(false);
  });
});

describe('a supported locale', () => {
  it('renders nothing, in any language, until its translations are loaded', async () => {
    backend.hold.add('ko');

    renderAt('/ko');

    await waitFor(() => expect(backend.requested).toContain('ko'));
    expect(screen.queryByTestId('home-page')).not.toBeInTheDocument();

    backend.release('ko');

    expect(await screen.findByTestId('home-page')).toHaveTextContent('ko');
  });

  it('loads only that locale', () => {
    expect(backend.requested).toEqual(['ko']);
  });

  it('keeps the language on screen while the next locale loads', async () => {
    backend.hold.add('ja');
    renderAt('/ko');

    fireEvent.click(await screen.findByRole('link', { name: 'ja' }));

    await waitFor(() => expect(backend.requested).toContain('ja'));
    expect(screen.getByTestId('home-page')).toBeInTheDocument();
    expect(i18n.language).toBe('ko');

    backend.release('ja');

    await waitFor(() => expect(i18n.language).toBe('ja'));
    expect(screen.getByTestId('home-page')).toHaveTextContent('ja');
  });

  it('fails when its translations cannot be loaded', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    backend.fail.add('th');
    renderAt('/ja');

    fireEvent.click(await screen.findByRole('link', { name: 'th' }));

    expect(await screen.findByTestId('failure')).toHaveTextContent('The translations for th could not be loaded');
    expect(screen.queryByTestId('home-page')).not.toBeInTheDocument();
  });
});

describe('the root path', () => {
  it("goes to the browser's language when it is supported", async () => {
    browserLanguageIs('fr-FR');

    renderAt('/');

    expect(await screen.findByTestId('home-page')).toHaveTextContent('fr');
  });

  it("offers the language picker when the browser's language is not supported", async () => {
    browserLanguageIs('sw-KE');

    renderAt('/');

    await waitFor(() => expect(pickerLinks()).toHaveLength(AVAILABLE_LOCALES.length));
    expect(pickerLinks().map((link) => link.getAttribute('href'))).toEqual(
      AVAILABLE_LOCALES.map((code) => `/${code}`),
    );
    expect(screen.queryByTestId('home-page')).not.toBeInTheDocument();
  });
});

describe('the language picker', () => {
  it('names each language in that language, and marks it as such', async () => {
    browserLanguageIs('sw-KE');

    renderAt('/');

    await waitFor(() => expect(pickerLinks()).toHaveLength(AVAILABLE_LOCALES.length));
    expect(pickerLinks().map((link) => link.lang)).toEqual([...AVAILABLE_LOCALES]);
    expect(screen.getByRole('link', { name: 'Français' })).toHaveAttribute('href', '/fr');
    expect(screen.getByRole('link', { name: 'العربية' })).toHaveAttribute('href', '/ar');
    expect(screen.getByRole('link', { name: '日本語' })).toHaveAttribute('href', '/ja');
  });

  it('is what an unsupported locale gets, with the rest of the URL kept for the language chosen', async () => {
    renderAt('/xx/know/discover?tab=recent#top');

    await waitFor(() => expect(pickerLinks()).toHaveLength(AVAILABLE_LOCALES.length));
    expect(screen.getByRole('link', { name: 'Français' }))
      .toHaveAttribute('href', '/fr/know/discover?tab=recent#top');
    expect(screen.queryByTestId('home-page')).not.toBeInTheDocument();
  });

  it('does not ask i18next for the unsupported locale', async () => {
    renderAt('/xx');

    await waitFor(() => expect(pickerLinks()).toHaveLength(AVAILABLE_LOCALES.length));
    expect(backend.requested).not.toContain('xx');
  });
});
