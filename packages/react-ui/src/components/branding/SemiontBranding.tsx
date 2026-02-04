"use client";

import React from 'react';
import './Branding.css';

type TranslateFn = (key: string) => string;

interface SemiontBrandingProps {
  t: TranslateFn;
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showTagline?: boolean;
  animated?: boolean;
  compactTagline?: boolean;
}

export function SemiontBranding({
  t,
  className = "",
  size = 'lg',
  showTagline = true,
  animated = true,
  compactTagline = false
}: SemiontBrandingProps) {
  return (
    <div
      className={`semiont-branding ${className}`}
      data-size={size}
      data-animated={animated}
      data-compact-tagline={compactTagline}
    >
      {/* Main heading */}
      <h1 className="semiont-branding-title">
        <span className="semiont-branding-text">
          Semiont
        </span>
      </h1>

      {/* Tagline */}
      {showTagline && (
        <h2 className="semiont-branding-tagline">
          {t('tagline')}
        </h2>
      )}
    </div>
  );
}
