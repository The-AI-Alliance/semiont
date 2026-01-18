'use client';

import React from 'react';
import { useRouter } from '@/i18n/routing';
import { SearchModal } from '@semiont/react-ui';
import { useTranslations } from 'next-intl';

interface GlobalSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function GlobalSearchModal({ isOpen, onClose }: GlobalSearchModalProps) {
  const router = useRouter();
  const t = useTranslations('Search');

  const handleNavigate = (type: 'resource' | 'entity', id: string) => {
    if (type === 'resource') {
      router.push(`/know/resource/${encodeURIComponent(id)}`);
    } else {
      router.push(`/know/entity/${id}`);
    }
  };

  return (
    <SearchModal
      isOpen={isOpen}
      onClose={onClose}
      onNavigate={handleNavigate}
      translations={{
        placeholder: t('placeholder'),
        searching: t('searching'),
        noResults: t('noResults'),
        startTyping: t('startTyping'),
        navigate: t('navigate'),
        select: t('select'),
        close: t('close'),
        enter: t('enter'),
        esc: t('esc'),
      }}
    />
  );
}