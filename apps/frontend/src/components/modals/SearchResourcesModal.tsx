import React from 'react';
import { ResourceSearchModal } from '@semiont/react-ui';
import { useTranslation } from 'react-i18next';

interface SearchResourcesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (documentId: string) => void;
  searchTerm?: string;
}

export function SearchResourcesModal({ isOpen, onClose, onSelect, searchTerm = '' }: SearchResourcesModalProps) {
  const { t: _t } = useTranslation();
  const t = (k: string, p?: Record<string, unknown>) => _t(`SearchResources.${k}`, p as any) as string;

  return (
    <ResourceSearchModal
      isOpen={isOpen}
      onClose={onClose}
      onSelect={onSelect}
      searchTerm={searchTerm}
      translations={{
        title: t('title'),
        placeholder: t('placeholder'),
        searching: t('searching'),
        noResults: t('noResults'),
        close: t('close')
      }}
    />
  );
}