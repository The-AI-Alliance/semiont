import { redirect } from '@/i18n/routing';
import { getLocale } from 'next-intl/server';

export default async function AdminPage() {
  // Middleware has already verified admin access
  const locale = await getLocale();

  // Redirect to the default admin page
  redirect({ href: '/admin/users', locale });
}