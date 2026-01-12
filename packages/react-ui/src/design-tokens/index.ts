/**
 * Semiont Design Tokens
 *
 * Core design tokens for the Semiont design system.
 * These tokens provide the foundation for all component styling
 * and can be consumed via JavaScript or CSS variables.
 */

export const tokens = {
  colors: {
    primary: {
      50: '#eff6ff',
      100: '#dbeafe',
      200: '#bfdbfe',
      300: '#93c5fd',
      400: '#60a5fa',
      500: '#0080ff', // Main brand color
      600: '#0066cc',
      700: '#0052a3',
      800: '#1e40af',
      900: '#1e3a8a',
    },
    secondary: {
      50: '#f0fffe',
      100: '#e0fffd',
      200: '#b3fffa',
      300: '#66fff6',
      400: '#1afff1',
      500: '#00ffff', // Cyan accent
      600: '#00cccc',
      700: '#00a3a3',
      800: '#007a7a',
      900: '#005252',
    },
    semantic: {
      error: '#ef4444',
      errorLight: '#fca5a5',
      errorDark: '#b91c1c',
      warning: '#f59e0b',
      warningLight: '#fcd34d',
      warningDark: '#d97706',
      success: '#10b981',
      successLight: '#6ee7b7',
      successDark: '#047857',
      info: '#3b82f6',
      infoLight: '#93c5fd',
      infoDark: '#1d4ed8',
    },
    neutral: {
      0: '#ffffff',
      50: '#f9fafb',
      100: '#f3f4f6',
      200: '#e5e7eb',
      300: '#d1d5db',
      400: '#9ca3af',
      500: '#6b7280',
      600: '#4b5563',
      700: '#374151',
      800: '#1f2937',
      900: '#111827',
      950: '#030712',
      1000: '#000000',
    },
    background: {
      primary: '#ffffff',
      secondary: '#f9fafb',
      tertiary: '#f3f4f6',
      inverse: '#111827',
    },
    text: {
      primary: '#111827',
      secondary: '#4b5563',
      tertiary: '#6b7280',
      disabled: '#9ca3af',
      inverse: '#ffffff',
    }
  },

  spacing: {
    0: '0',
    xs: '0.25rem',   // 4px
    sm: '0.5rem',    // 8px
    md: '1rem',      // 16px
    lg: '1.5rem',    // 24px
    xl: '2rem',      // 32px
    '2xl': '2.5rem', // 40px
    '3xl': '3rem',   // 48px
    '4xl': '4rem',   // 64px
    '5xl': '5rem',   // 80px
  },

  typography: {
    fontFamily: {
      sans: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      mono: 'JetBrains Mono, "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
    },
    fontSize: {
      xs: '0.75rem',     // 12px
      sm: '0.875rem',    // 14px
      base: '1rem',      // 16px
      lg: '1.125rem',    // 18px
      xl: '1.25rem',     // 20px
      '2xl': '1.5rem',   // 24px
      '3xl': '1.875rem', // 30px
      '4xl': '2.25rem',  // 36px
      '5xl': '3rem',     // 48px
    },
    fontWeight: {
      thin: 100,
      light: 300,
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
      black: 900,
    },
    lineHeight: {
      none: 1,
      tight: 1.25,
      snug: 1.375,
      normal: 1.5,
      relaxed: 1.625,
      loose: 2,
    }
  },

  borderRadius: {
    none: '0',
    sm: '0.125rem',   // 2px
    base: '0.25rem',  // 4px
    md: '0.375rem',   // 6px
    lg: '0.5rem',     // 8px
    xl: '0.75rem',    // 12px
    '2xl': '1rem',    // 16px
    '3xl': '1.5rem',  // 24px
    full: '9999px',
  },

  shadows: {
    none: 'none',
    xs: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    sm: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
    base: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
    md: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
    lg: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
    xl: '0 25px 50px -12px rgb(0 0 0 / 0.25)',
    inner: 'inset 0 2px 4px 0 rgb(0 0 0 / 0.05)',
  },

  transitions: {
    duration: {
      fast: '150ms',
      base: '250ms',
      slow: '350ms',
      slower: '500ms',
    },
    timing: {
      linear: 'linear',
      ease: 'cubic-bezier(0.4, 0, 0.2, 1)',
      easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
      easeOut: 'cubic-bezier(0, 0, 0.2, 1)',
      easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
    }
  },

  breakpoints: {
    sm: '640px',
    md: '768px',
    lg: '1024px',
    xl: '1280px',
    '2xl': '1536px',
  }
};

/**
 * Generate CSS custom properties from design tokens
 */
export function generateCSSVariables(): string {
  const cssVars: string[] = [':root {'];

  // Colors
  Object.entries(tokens.colors.primary).forEach(([key, value]) => {
    cssVars.push(`  --semiont-color-primary-${key}: ${value};`);
  });

  Object.entries(tokens.colors.secondary).forEach(([key, value]) => {
    cssVars.push(`  --semiont-color-secondary-${key}: ${value};`);
  });

  Object.entries(tokens.colors.semantic).forEach(([key, value]) => {
    cssVars.push(`  --semiont-color-${key.toLowerCase().replace(/([A-Z])/g, '-$1').toLowerCase()}: ${value};`);
  });

  Object.entries(tokens.colors.neutral).forEach(([key, value]) => {
    cssVars.push(`  --semiont-color-neutral-${key}: ${value};`);
  });

  // Spacing
  Object.entries(tokens.spacing).forEach(([key, value]) => {
    cssVars.push(`  --semiont-spacing-${key}: ${value};`);
  });

  // Typography
  Object.entries(tokens.typography.fontSize).forEach(([key, value]) => {
    cssVars.push(`  --semiont-text-${key}: ${value};`);
  });

  Object.entries(tokens.typography.fontWeight).forEach(([key, value]) => {
    cssVars.push(`  --semiont-font-${key}: ${value};`);
  });

  cssVars.push(`  --semiont-font-sans: ${tokens.typography.fontFamily.sans};`);
  cssVars.push(`  --semiont-font-mono: ${tokens.typography.fontFamily.mono};`);

  // Border radius
  Object.entries(tokens.borderRadius).forEach(([key, value]) => {
    cssVars.push(`  --semiont-radius-${key}: ${value};`);
  });

  // Shadows
  Object.entries(tokens.shadows).forEach(([key, value]) => {
    cssVars.push(`  --semiont-shadow-${key}: ${value};`);
  });

  // Transitions
  Object.entries(tokens.transitions.duration).forEach(([key, value]) => {
    cssVars.push(`  --semiont-duration-${key}: ${value};`);
  });

  cssVars.push('}');

  return cssVars.join('\n');
}

// Export a pre-generated CSS string for convenience
export const cssVariables = generateCSSVariables();

// Type exports for TypeScript support
export type ColorToken = keyof typeof tokens.colors;
export type SpacingToken = keyof typeof tokens.spacing;
export type TypographyToken = keyof typeof tokens.typography;
export type BorderRadiusToken = keyof typeof tokens.borderRadius;
export type ShadowToken = keyof typeof tokens.shadows;
export type TransitionToken = keyof typeof tokens.transitions;