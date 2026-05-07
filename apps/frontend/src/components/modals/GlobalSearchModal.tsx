import React from 'react';
import { useRouter } from '@/i18n/routing';
import { SearchModal } from '@semiont/react-ui';
import { useTranslation } from 'react-i18next';

interface GlobalSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function GlobalSearchModal({ isOpen, onClose }: GlobalSearchModalProps) {
  const router = useRouter();
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`Search.${k}`, p as any) as string;

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