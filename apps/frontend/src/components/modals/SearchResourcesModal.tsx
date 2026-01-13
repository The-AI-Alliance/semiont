'use client';

import React from 'react';
import { ResourceSearchModal } from '@semiont/react-ui';
import { useTranslations } from 'next-intl';

interface SearchResourcesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (documentId: string) => void;
  searchTerm?: string;
}

export function SearchResourcesModal({ isOpen, onClose, onSelect, searchTerm = '' }: SearchResourcesModalProps) {
  const t = useTranslations('SearchResources');

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