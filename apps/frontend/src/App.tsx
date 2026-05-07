import React, { useEffect } from 'react';
import { Routes, Route, Navigate, Outlet, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DEFAULT_LOCALE, isSupportedLocale } from './i18n/config';

// Lazy-load page components for code splitting
const LocaleLayout = React.lazy(() => import('./app/[locale]/layout'));
const HomePage = React.lazy(() => import('./app/[locale]/page'));
const AboutPage = React.lazy(() => import('./app/[locale]/about/page'));
const PrivacyPage = React.lazy(() => import('./app/[locale]/privacy/page'));
const TermsPage = React.lazy(() => import('./app/[locale]/terms/page'));
const ConnectPage = React.lazy(() => import('./app/[locale]/auth/connect/page'));
const SignUpPage = React.lazy(() => import('./app/[locale]/auth/signup/page'));
const AuthErrorPage = React.lazy(() => import('./app/[locale]/auth/error/page'));
const WelcomePage = React.lazy(() => import('./app/[locale]/auth/welcome/page'));
import { AuthShell } from './contexts/AuthShell';
const KnowledgeLayout = React.lazy(() => import('./app/[locale]/know/layout'));
const KnowledgePage = React.lazy(() => import('./app/[locale]/know/page'));
const KnowledgeDiscoverPage = React.lazy(() => import('./app/[locale]/know/discover/page'));
const KnowledgeComposePage = React.lazy(() => import('./app/[locale]/know/compose/page'));
const KnowledgeResourcePage = React.lazy(() => import('./app/[locale]/know/resource/[id]/page'));
const AdminLayout = React.lazy(() => import('./app/[locale]/admin/layout'));
const AdminPage = React.lazy(() => import('./app/[locale]/admin/page'));
const AdminUsersPage = React.lazy(() => import('./app/[locale]/admin/users/client'));
const AdminSecurityPage = React.lazy(() => import('./app/[locale]/admin/security/client'));
const AdminExchangePage = React.lazy(() => import('./app/[locale]/admin/exchange/client'));
const AdminDevOpsPage = React.lazy(() => import('./app/[locale]/admin/devops/page'));
const ModerateLayout = React.lazy(() => import('./app/[locale]/moderate/layout'));
const ModeratePage = React.lazy(() => import('./app/[locale]/moderate/page'));
const ModerateRecentPage = React.lazy(() => import('./app/[locale]/moderate/recent/page'));
const ModerateEntityTagsPage = React.lazy(() => import('./app/[locale]/moderate/entity-tags/page'));
const ModerateTagSchemasPage = React.lazy(() => import('./app/[locale]/moderate/tag-schemas/page'));
const ModerateLinkedDataPage = React.lazy(() => import('./app/[locale]/moderate/linked-data/client'));
const NotFoundPage = React.lazy(() => import('./app/[locale]/not-found'));

/**
 * LocaleGuard — validates the :locale param and loads the locale bundle.
 * Renders children once the locale bundle is ready; redirects unknown locales to default.
 */
function LocaleGuard({ children }: { children: React.ReactNode }) {
  const { locale } = useParams<{ locale: string }>();
  const { i18n } = useTranslation();

  useEffect(() => {
    if (!locale) return;
    const lang = isSupportedLocale(locale) ? locale : DEFAULT_LOCALE;
    if (i18n.language !== lang) {
      i18n.changeLanguage(lang);
    }
  }, [locale, i18n]);

  if (!locale || !isSupportedLocale(locale)) {
    return <Navigate to={`/${DEFAULT_LOCALE}`} replace />;
  }

  return <>{children}</>;
}

/**
 * ProtectedLayout — pathless wrapper that mounts AuthShell once for every
 * authenticated route group below it. Section layouts (know/, admin/,
 * moderate/, auth/welcome) live under this route so cross-section
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
 * RootRedirect — detect browser language and redirect / to /:locale
 */
function RootRedirect() {
  const navigate = useNavigate();

  useEffect(() => {
    const browserLocale = navigator.language.split('-')[0] ?? DEFAULT_LOCALE;
    const locale = isSupportedLocale(browserLocale) ? browserLocale : DEFAULT_LOCALE;
    navigate(`/${locale}`, { replace: true });
  }, [navigate]);

  return null;
}

export default function App() {
  return (
    <React.Suspense fallback={null}>
      <Routes>
        {/* Root: detect locale and redirect */}
        <Route path="/" element={<RootRedirect />} />

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
          <Route path="about" element={<AboutPage />} />
          <Route path="privacy" element={<PrivacyPage />} />
          <Route path="terms" element={<TermsPage />} />

          {/* Auth routes (pre-app — no AuthShell) */}
          <Route path="auth/connect" element={<ConnectPage />} />
          <Route path="auth/signup" element={<SignUpPage />} />
          <Route path="auth/error" element={<AuthErrorPage />} />

          {/* Protected routes — single AuthShell parent across every authenticated section */}
          <Route element={<ProtectedLayout />}>
            <Route path="auth/welcome" element={<WelcomePage />} />

            {/* Knowledge section */}
            <Route path="know" element={<KnowledgeLayout />}>
              <Route index element={<KnowledgePage />} />
              <Route path="discover" element={<KnowledgeDiscoverPage />} />
              <Route path="compose" element={<KnowledgeComposePage />} />
              <Route path="resource/:id" element={<KnowledgeResourcePage />} />
            </Route>

            {/* Admin section */}
            <Route path="admin" element={<AdminLayout />}>
              <Route index element={<AdminPage />} />
              <Route path="users" element={<AdminUsersPage />} />
              <Route path="security" element={<AdminSecurityPage />} />
              <Route path="exchange" element={<AdminExchangePage />} />
              <Route path="devops" element={<AdminDevOpsPage />} />
            </Route>

            {/* Moderation section */}
            <Route path="moderate" element={<ModerateLayout />}>
              <Route index element={<ModeratePage />} />
              <Route path="recent" element={<ModerateRecentPage />} />
              <Route path="entity-tags" element={<ModerateEntityTagsPage />} />
              <Route path="tag-schemas" element={<ModerateTagSchemasPage />} />
              <Route path="linked-data" element={<ModerateLinkedDataPage />} />
            </Route>
          </Route>

          {/* 404 within locale */}
          <Route path="*" element={<NotFoundPage />} />
        </Route>

        {/* Global 404 fallback */}
        <Route path="*" element={<Navigate to={`/${DEFAULT_LOCALE}`} replace />} />
      </Routes>
    </React.Suspense>
  );
}
