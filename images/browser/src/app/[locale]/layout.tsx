import { Outlet } from 'react-router';
import { Providers } from '../providers';
import { SkipLinks } from '@semiont/react-ui';

/**
 * Locale Layout — root layout for all /:locale/* routes.
 *
 * Mounts `Providers` (the auth-independent contexts) and the skip links.
 * The auth-dependent tree (the protected error boundary and the session
 * modals) is `AuthShell`, which `ProtectedLayout` in App.tsx mounts above
 * know/ and moderate/.
 */
export default function LocaleLayout() {
  return (
    <Providers>
      <SkipLinks />
      <Outlet />
    </Providers>
  );
}
