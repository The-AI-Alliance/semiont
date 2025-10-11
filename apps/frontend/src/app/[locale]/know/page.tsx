'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';

export default function KnowledgePage() {
  const t = useTranslations('Knowledge');
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    // Check if there's a last viewed document
    const lastDocumentId = localStorage.getItem('lastViewedDocumentId');
    
    if (lastDocumentId) {
      // If there's a last viewed document, go to it
      router.replace(`/know/document/${lastDocumentId}`);
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