import { Outlet } from 'react-router-dom';
import { Providers } from '../providers';
import { CookieBanner } from '@/components/CookieBanner';
import { SkipLinks } from '@semiont/react-ui';
import { ClientModals } from '@/components/ClientModals';

/**
 * Locale Layout — root layout for all /:locale/* routes.
 *
 * Replaces the Next.js App Router locale layout. Font loading now happens in
 * globals.css via @fontsource imports. Metadata is in index.html.
 * Auth guarding for admin/moderate happens in their respective layouts.
 */
export default function LocaleLayout() {
  return (
    <Providers>
      <SkipLinks />
      <ClientModals />
      <Outlet />
      <CookieBanner />
    </Providers>
  );
}
