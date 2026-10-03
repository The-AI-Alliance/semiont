import React, { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Outlet, useParams, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { isSupportedLocale } from './i18n/config';
import { LanguagePicker } from './app/language-picker';

// Lazy-load page components for code splitting
const LocaleLayout = React.lazy(() => import('./app/[locale]/layout'));
const HomePage = React.lazy(() => import('./app/[locale]/page'));
const ConnectPage = React.lazy(() => import('./app/[locale]/auth/connect/page'));
const AuthErrorPage = React.lazy(() => import('./app/[locale]/auth/error/page'));
const AuthCallbackPage = React.lazy(() => import('./app/[locale]/auth/callback/page'));
import { AuthShell } from './contexts/AuthShell';
const KnowledgeLayout = React.lazy(() => import('./app/[locale]/know/layout'));
const KnowledgePage = React.lazy(() => import('./app/[locale]/know/page'));
const KnowledgeDiscoverPage = React.lazy(() => import('./app/[locale]/know/discover/page'));
const KnowledgeComposePage = React.lazy(() => import('./app/[locale]/know/compose/page'));
const KnowledgeResourcePage = React.lazy(() => import('./app/[locale]/know/resource/[id]/page'));
const ModerateLayout = React.lazy(() => import('./app/[locale]/moderate/layout'));
const ModeratePage = React.lazy(() => import('./app/[locale]/moderate/page'));
const ModerateRecentPage = React.lazy(() => import('./app/[locale]/moderate/recent/page'));
const ModerateEntityTagsPage = React.lazy(() => import('./app/[locale]/moderate/entity-tags/page'));
const ModerateTagSchemasPage = React.lazy(() => import('./app/[locale]/moderate/tag-schemas/page'));
const NotFoundPage = React.lazy(() => import('./app/[locale]/not-found'));

/**
 * LocaleGuard — validates the :locale param and loads the locale bundle.
 *
 * No language is assumed. A locale the Browser does not serve gets the
 * language picker. Children render only once i18next has a language whose
 * bundle is loaded: nothing before the first one arrives, and the language
 * already on screen while the route's next one loads. A locale whose bundle
 * cannot be loaded is an error.
 */
function LocaleGuard({ children }: { children: React.ReactNode }) {
  const { locale } = useParams<{ locale: string }>();
  const { pathname, search, hash } = useLocation();
  const { i18n } = useTranslation();
  const [outcome, setOutcome] = useState<{ locale: string; loaded: boolean } | null>(null);
  const routeLocale = locale !== undefined && isSupportedLocale(locale) ? locale : null;

  useEffect(() => {
    if (routeLocale === null) return;
    if (i18n.language === routeLocale && i18n.hasResourceBundle(routeLocale, 'translation')) return;

    let current = true;
    i18n.changeLanguage(routeLocale).then(() => {
      if (current) {
        setOutcome({ locale: routeLocale, loaded: i18n.hasResourceBundle(routeLocale, 'translation') });
      }
    });
    return () => {
      current = false;
    };
  }, [routeLocale, i18n]);

  if (routeLocale === null) {
    return <LanguagePicker path={pathname.replace(/^\/[^/]+/, '') + search + hash} />;
  }

  if (outcome?.locale === routeLocale && !outcome.loaded) {
    throw new Error(`The translations for ${routeLocale} could not be loaded`);
  }

  if (!i18n.language || !i18n.hasResourceBundle(i18n.language, 'translation')) {
    return null;
  }

  return <>{children}</>;
}

/**
 * ProtectedLayout — pathless wrapper that mounts AuthShell once for every
 * authenticated route group below it. Section layouts (know/,
 * moderate/) live under this route so cross-section
 * navigation keeps the AuthShell tree (ProtectedErrorBoundary + the two
 * auth-failure modals) mounted instead of tearing it down and rebuilding.
 */
function ProtectedLayout() {
  return (
    <AuthShell>
      <Outlet />
    </AuthShell>
  );
}

/**
 * RootLocale — sends / to the browser's language when the Browser serves it,
 * and offers the language picker when it does not.
 */
function RootLocale() {
  const browserLocale = navigator.language.split('-')[0];

  if (browserLocale !== undefined && isSupportedLocale(browserLocale)) {
    return <Navigate to={`/${browserLocale}`} replace />;
  }

  return <LanguagePicker path="" />;
}

export default function App() {
  return (
    <React.Suspense fallback={null}>
      <Routes>
        {/* Root: the browser's language, or the language picker */}
        <Route path="/" element={<RootLocale />} />

        {/* Locale-prefixed routes */}
        <Route
          path="/:locale"
          element={
            <LocaleGuard>
              <LocaleLayout />
            </LocaleGuard>
          }
        >
          <Route index element={<HomePage />} />

          {/* Auth routes (pre-app — no AuthShell) */}
          <Route path="auth/connect" element={<ConnectPage />} />
          <Route path="auth/error" element={<AuthErrorPage />} />
          <Route path="auth/callback" element={<AuthCallbackPage />} />

          {/* Protected routes — single AuthShell parent across every authenticated section */}
          <Route element={<ProtectedLayout />}>

            {/* Knowledge section */}
            <Route path="know" element={<KnowledgeLayout />}>
              <Route index element={<KnowledgePage />} />
              <Route path="discover" element={<KnowledgeDiscoverPage />} />
              <Route path="compose" element={<KnowledgeComposePage />} />
              <Route path="resource/:id" element={<KnowledgeResourcePage />} />
            </Route>

            {/* Moderation section */}
            <Route path="moderate" element={<ModerateLayout />}>
              <Route index element={<ModeratePage />} />
              <Route path="recent" element={<ModerateRecentPage />} />
              <Route path="entity-tags" element={<ModerateEntityTagsPage />} />
              <Route path="tag-schemas" element={<ModerateTagSchemasPage />} />
            </Route>
          </Route>

          {/* 404 within locale */}
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </React.Suspense>
  );
}
