import { Outlet } from 'react-router';
import { Providers } from '../providers';
import { SkipLinks } from '@semiont/react-ui';

/**
 * Locale Layout — root layout for all /:locale/* routes.
 *
 * Mounts only auth-independent providers. Auth-dependent providers
 * (KnowledgeBaseProvider, AuthProvider, SessionProvider, modals)
 * are mounted via AuthShell in protected layouts (know/, admin/,
 * moderate/, auth/welcome/).
 */
export default function LocaleLayout() {
  return (
    <Providers>
      <SkipLinks />
      <Outlet />
    </Providers>
  );
}
