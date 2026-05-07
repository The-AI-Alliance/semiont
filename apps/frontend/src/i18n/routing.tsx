/**
 * Routing abstraction layer — React Router implementation
 *
 * All call sites import from @/i18n/routing and do not need to change
 * when the underlying router changes.
 *
 * Key behaviours:
 * - Link: locale-prefixed anchor rendered via react-router-dom
 * - useRouter: locale-aware push/replace/back
 * - usePathname: returns path WITHOUT locale prefix
 * - redirect: programmatic navigation without locale prefix
 */

import React from 'react';
import {
  Link as RouterLink,
  useNavigate,
  useLocation,
  useParams,
  Navigate,
} from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LOCALES, DEFAULT_LOCALE, isSupportedLocale } from './config';

export { SUPPORTED_LOCALES, DEFAULT_LOCALE };

// ── Link ─────────────────────────────────────────────────────────────────────

type LinkProps = React.ComponentProps<typeof RouterLink>;

/**
 * Locale-aware Link. Prepends the current locale to the href.
 */
export const Link = React.forwardRef<HTMLAnchorElement, LinkProps>(
  function Link({ to, ...props }, ref) {
    const { i18n } = useTranslation();
    const params = useParams<{ locale?: string }>();
    const locale = i18n.language || params.locale || DEFAULT_LOCALE;
    const target = typeof to === 'string' ? `/${locale}${to.startsWith('/') ? to : `/${to}`}` : to;
    return <RouterLink ref={ref} to={target} {...props} />;
  },
);

// ── useRouter ─────────────────────────────────────────────────────────────────

type RouterOptions = { locale?: string };

export function useRouter() {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const params = useParams<{ locale?: string }>();

  function prefixLocale(path: string, locale?: string): string {
    const lang = locale || i18n.language || params.locale || DEFAULT_LOCALE;
    return `/${lang}${path.startsWith('/') ? path : `/${path}`}`;
  }

  return {
    push(path: string, options?: RouterOptions) {
      navigate(prefixLocale(path, options?.locale));
    },
    replace(path: string, options?: RouterOptions) {
      navigate(prefixLocale(path, options?.locale), { replace: true });
    },
    back() {
      navigate(-1);
    },
    forward() {
      navigate(1);
    },
    refresh() {
      window.location.reload();
    },
    prefetch(_path: string) {
      // No-op: Vite/React Router handles prefetching differently
    },
  };
}

// ── usePathname ───────────────────────────────────────────────────────────────

/**
 * Returns the path WITHOUT the locale prefix.
 * e.g. /en/know/discover → /know/discover
 */
export function usePathname(): string {
  const { pathname } = useLocation();
  // Strip leading /{locale}
  const match = pathname.match(/^\/[a-z]{2}(\/.*)?$/);
  if (match) {
    return match[1] ?? '/';
  }
  return pathname;
}

// ── redirect ─────────────────────────────────────────────────────────────────

/**
 * Render a redirect component. Pass { href, locale } to redirect with locale,
 * or just a string href to redirect to an absolute path.
 */
export function redirect(target: string | { href: string; locale?: string }): React.ReactElement {
  const { i18n } = useTranslation();
  const locale = typeof target === 'string' ? (i18n.language || DEFAULT_LOCALE) : (target.locale || i18n.language || DEFAULT_LOCALE);
  const href = typeof target === 'string' ? target : target.href;
  const to = `/${locale}${href.startsWith('/') ? href : `/${href}`}`;
  return <Navigate to={to} replace />;
}

// ── useParams with locale ────────────────────────────────────────────────────

export function useLocale(): string {
  const params = useParams<{ locale?: string }>();
  const { i18n } = useTranslation();
  const localeFromParams = params.locale;
  if (localeFromParams && isSupportedLocale(localeFromParams)) {
    return localeFromParams;
  }
  return i18n.language || DEFAULT_LOCALE;
}
