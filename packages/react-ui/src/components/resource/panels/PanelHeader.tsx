'use client';

import React from 'react';
import { ANNOTATORS } from '../../../lib/annotation-registry';

interface PanelHeaderProps {
  annotationType: keyof typeof ANNOTATORS;
  count: number;
  title: string;
}

/**
 * Shared header for annotation panels
 *
 * Displays the annotation icon, translated title, and count in a consistent format
 */
export function PanelHeader({ annotationType, count, title }: PanelHeaderProps) {
  const metadata = ANNOTATORS[annotationType];

  return (
    <div className="semiont-panel-header">
      <h2 className="semiont-panel-header__title">
        <span className="semiont-panel-header__text">{title}</span>
        <span className="semiont-panel-header__count">({count})</span>
      </h2>
    </div>
  );
}
