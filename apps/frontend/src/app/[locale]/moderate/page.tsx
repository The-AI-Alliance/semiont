import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@/i18n/routing';

export default function ModeratePage() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Moderation.${k}`, p as any) as string;
  const router = useRouter();

  useEffect(() => {
    // Redirect to Recent Documents as the default page
    router.replace('/moderate/recent');
  }, [router]);

  return (
    <div className="flex items-center justify-center py-20">
      <p className="text-gray-600 dark:text-gray-300">{t('redirecting')}</p>
    </div>
  );
}