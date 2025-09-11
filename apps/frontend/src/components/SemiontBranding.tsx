"use client";

import React from 'react';

interface SemiontBrandingProps {
  isDark?: boolean;
  className?: string;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showTagline?: boolean;
  animated?: boolean;
  compactTagline?: boolean;
}

export function SemiontBranding({ 
  isDark = false,
  className = "",
  size = 'lg',
  showTagline = true,
  animated = true,
  compactTagline = false
}: SemiontBrandingProps) {
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

  const gradientStyle = isDark 
    ? 'linear-gradient(135deg, #ffffff 0%, #00f5ff 50%, #ffffff 100%)'
    : 'linear-gradient(135deg, #1f2937 0%, #0891b2 50%, #1f2937 100%)';

  const brandingContent = (
    <div className={`flex flex-col items-center justify-center text-center ${className}`}>
      {/* Main heading */}
      <h1 
        className={`${sizeClasses[size]} font-bold tracking-tight ${compactTagline && showTagline ? 'mb-1' : 'mb-6 sm:mb-8'} uppercase font-orbitron ${animated ? 'animate-in fade-in slide-in-from-bottom-4 duration-1000 ease-out' : ''}`}
      >
        <span
          className="bg-clip-text text-transparent"
          style={{ 
            backgroundImage: gradientStyle
          }}
        >
          Semiont
        </span>
      </h1>

      {/* Tagline */}
      {showTagline && (
        <h2 
          className={`${compactTagline ? compactTaglineSizes[size] : taglineSizes[size]} ${isDark ? 'text-cyan-400' : 'text-cyan-600'} ${compactTagline ? '' : 'tracking-wide'} font-orbitron ${animated ? 'animate-in fade-in slide-in-from-bottom-2 duration-1000 ease-out delay-300' : ''}`}
        >
          make meaning
        </h2>
      )}
    </div>
  );

  return brandingContent;
}