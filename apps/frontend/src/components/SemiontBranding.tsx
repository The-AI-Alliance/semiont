"use client";

import React from 'react';
import { useTranslations } from 'next-intl';

interface SemiontBrandingProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showTagline?: boolean;
  animated?: boolean;
  compactTagline?: boolean;
}

export function SemiontBranding({
  className = "",
  size = 'lg',
  showTagline = true,
  animated = true,
  compactTagline = false
}: SemiontBrandingProps) {
  const t = useTranslations('Home');
  const sizeClasses = {
    sm: 'text-2xl sm:text-3xl md:text-4xl',
    md: 'text-3xl sm:text-4xl md:text-5xl lg:text-6xl',
    lg: 'text-4xl sm:text-5xl md:text-6xl lg:text-7xl xl:text-8xl',
    xl: 'text-5xl sm:text-6xl md:text-7xl lg:text-8xl xl:text-9xl'
  };

  const taglineSizes = {
    sm: 'text-lg sm:text-xl',
    md: 'text-xl sm:text-2xl md:text-3xl',
    lg: 'text-xl sm:text-2xl md:text-3xl lg:text-4xl',
    xl: 'text-2xl sm:text-3xl md:text-4xl lg:text-5xl'
  };

  const compactTaglineSizes = {
    sm: 'text-sm tracking-widest',
    md: 'text-base tracking-widest',
    lg: 'text-base tracking-widest',
    xl: 'text-lg tracking-widest'
  };

  const brandingContent = (
    <div className={`flex flex-col items-center justify-center text-center ${className}`}>
      {/* Main heading */}
      <h1
        className={`${sizeClasses[size]} font-bold tracking-tight ${showTagline ? (compactTagline ? 'mb-1' : 'mb-6 sm:mb-8') : ''} uppercase font-orbitron ${animated ? 'animate-in fade-in slide-in-from-bottom-4 duration-1000 ease-out' : ''}`}
      >
        <span
          className="bg-clip-text text-transparent bg-gradient-to-r from-gray-800 via-cyan-600 to-gray-800 dark:from-white dark:via-cyan-400 dark:to-white"
        >
          Semiont
        </span>
      </h1>

      {/* Tagline */}
      {showTagline && (
        <h2
          className={`${compactTagline ? compactTaglineSizes[size] : taglineSizes[size]} text-cyan-600 dark:text-cyan-400 ${compactTagline ? '' : 'tracking-wide'} font-orbitron ${animated ? 'animate-in fade-in slide-in-from-bottom-2 duration-1000 ease-out delay-300' : ''}`}
        >
          {t('tagline')}
        </h2>
      )}
    </div>
  );

  return brandingContent;
}