import { Navigate } from 'react-router';
import { useLocale } from '@/i18n/routing';

export default function AdminPage() {
  const locale = useLocale();
  return <Navigate to={`/${locale}/admin/users`} replace />;
}
