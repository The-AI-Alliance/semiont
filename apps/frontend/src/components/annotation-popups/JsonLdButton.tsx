'use client';

import React from 'react';
import { buttonStyles } from '@/lib/button-styles';

interface JsonLdButtonProps {
  onClick: () => void;
}

export function JsonLdButton({ onClick }: JsonLdButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`${buttonStyles.secondary.base} w-full justify-center`}
    >
      📄 JSON-LD
    </button>
  );
}
