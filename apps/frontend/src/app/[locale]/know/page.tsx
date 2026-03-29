import { useEffect, useState } from 'react';
import { useRouter } from '@/i18n/routing';
import { useTranslation } from 'react-i18next';

export default function KnowledgePage() {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Sidebar.${k}`, p as any) as string;
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Check if there's a last viewed document
    const lastDocumentId = localStorage.getItem('lastViewedDocumentId');
    
    if (lastDocumentId) {
      // If there's a last viewed document, go to it
      router.replace(`/know/resource/${lastDocumentId}`);
    } else {
      // Otherwise, go to Discover
      router.replace('/know/discover');
    }
    
    setChecking(false);
  }, [router]);

  if (checking) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-600 dark:text-gray-300">{t('loading')}</p>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center py-20">
      <p className="text-gray-600 dark:text-gray-300">{t('redirecting')}</p>
    </div>
  );
}