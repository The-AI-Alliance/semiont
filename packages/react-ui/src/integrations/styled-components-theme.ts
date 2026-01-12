/**
 * Styled Components Theme for Semiont Components
 *
 * This provides a complete theme object and utilities for using
 * Semiont components with styled-components or emotion.
 */

import { tokens } from '../design-tokens';
import { css, DefaultTheme } from 'styled-components';

/**
 * Semiont theme object for styled-components
 */
export const semiontTheme: DefaultTheme = {
  colors: {
    ...tokens.colors,
    // Flatten semantic colors for easier access
    error: tokens.colors.semantic.error,
    errorLight: tokens.colors.semantic.errorLight,
    errorDark: tokens.colors.semantic.errorDark,
    warning: tokens.colors.semantic.warning,
    warningLight: tokens.colors.semantic.warningLight,
    warningDark: tokens.colors.semantic.warningDark,
    success: tokens.colors.semantic.success,
    successLight: tokens.colors.semantic.successLight,
    successDark: tokens.colors.semantic.successDark,
    info: tokens.colors.semantic.info,
    infoLight: tokens.colors.semantic.infoLight,
    infoDark: tokens.colors.semantic.infoDark,
  },
  spacing: tokens.spacing,
  typography: tokens.typography,
  borderRadius: tokens.borderRadius,
  shadows: tokens.shadows,
  transitions: tokens.transitions,
  breakpoints: tokens.breakpoints,
};

/**
 * Type augmentation for styled-components DefaultTheme
 */
declare module 'styled-components' {
  export interface DefaultTheme {
    colors: typeof tokens.colors & {
      error: string;
      errorLight: string;
      errorDark: string;
      warning: string;
      warningLight: string;
      warningDark: string;
      success: string;
      successLight: string;
      successDark: string;
      info: string;
      infoLight: string;
      infoDark: string;
    };
    spacing: typeof tokens.spacing;
    typography: typeof tokens.typography;
    borderRadius: typeof tokens.borderRadius;
    shadows: typeof tokens.shadows;
    transitions: typeof tokens.transitions;
    breakpoints: typeof tokens.breakpoints;
  }
}

/**
 * CSS mixins for common component patterns
 */
export const semiontMixins = {
  /**
   * Button base styles
   */
  buttonBase: css`
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: ${props => props.theme.typography.fontFamily.sans};
    font-weight: ${props => props.theme.typography.fontWeight.medium};
    line-height: ${props => props.theme.typography.lineHeight.snug};
    border: none;
    outline: none;
    cursor: pointer;
    transition: all ${props => props.theme.transitions.duration.base} ${props => props.theme.transitions.timing.ease};
    user-select: none;
    white-space: nowrap;
    text-decoration: none;

    &:focus-visible {
      outline: 2px solid ${props => props.theme.colors.primary[500]};
      outline-offset: 2px;
    }

    &:disabled,
    &[data-disabled="true"] {
      cursor: not-allowed;
      opacity: 0.5;
    }
  `,

  /**
   * Button variant styles
   */
  buttonVariant: (variant: string) => css`
    ${variant === 'primary' && css`
      background-color: ${props => props.theme.colors.primary[500]};
      color: ${props => props.theme.colors.neutral[0]};

      &:hover:not(:disabled):not([data-disabled="true"]) {
        background-color: ${props => props.theme.colors.primary[600]};
      }

      &:active:not(:disabled):not([data-disabled="true"]),
      &[data-active="true"]:not(:disabled):not([data-disabled="true"]) {
        background-color: ${props => props.theme.colors.primary[700]};
      }
    `}

    ${variant === 'secondary' && css`
      background-color: ${props => props.theme.colors.neutral[100]};
      color: ${props => props.theme.colors.neutral[900]};

      &:hover:not(:disabled):not([data-disabled="true"]) {
        background-color: ${props => props.theme.colors.neutral[200]};
      }

      &:active:not(:disabled):not([data-disabled="true"]),
      &[data-active="true"]:not(:disabled):not([data-disabled="true"]) {
        background-color: ${props => props.theme.colors.neutral[300]};
      }
    `}

    ${variant === 'tertiary' && css`
      background-color: transparent;
      color: ${props => props.theme.colors.primary[600]};
      box-shadow: inset 0 0 0 1px ${props => props.theme.colors.primary[200]};

      &:hover:not(:disabled):not([data-disabled="true"]) {
        background-color: ${props => props.theme.colors.primary[50]};
        box-shadow: inset 0 0 0 1px ${props => props.theme.colors.primary[300]};
      }

      &:active:not(:disabled):not([data-disabled="true"]),
      &[data-active="true"]:not(:disabled):not([data-disabled="true"]) {
        background-color: ${props => props.theme.colors.primary[100]};
        box-shadow: inset 0 0 0 1px ${props => props.theme.colors.primary[400]};
      }
    `}

    ${variant === 'danger' && css`
      background-color: ${props => props.theme.colors.error};
      color: ${props => props.theme.colors.neutral[0]};

      &:hover:not(:disabled):not([data-disabled="true"]) {
        background-color: ${props => props.theme.colors.errorDark};
      }

      &:active:not(:disabled):not([data-disabled="true"]),
      &[data-active="true"]:not(:disabled):not([data-disabled="true"]) {
        background-color: ${props => props.theme.colors.errorDark};
        filter: brightness(0.9);
      }
    `}

    ${variant === 'warning' && css`
      background-color: ${props => props.theme.colors.warning};
      color: ${props => props.theme.colors.neutral[900]};

      &:hover:not(:disabled):not([data-disabled="true"]) {
        background-color: ${props => props.theme.colors.warningDark};
      }

      &:active:not(:disabled):not([data-disabled="true"]),
      &[data-active="true"]:not(:disabled):not([data-disabled="true"]) {
        background-color: ${props => props.theme.colors.warningDark};
        filter: brightness(0.9);
      }
    `}

    ${variant === 'ghost' && css`
      background-color: transparent;
      color: ${props => props.theme.colors.text.primary};

      &:hover:not(:disabled):not([data-disabled="true"]) {
        background-color: ${props => props.theme.colors.neutral[100]};
      }

      &:active:not(:disabled):not([data-disabled="true"]),
      &[data-active="true"]:not(:disabled):not([data-disabled="true"]) {
        background-color: ${props => props.theme.colors.neutral[200]};
      }
    `}
  `,

  /**
   * Button size styles
   */
  buttonSize: (size: string) => css`
    ${size === 'xs' && css`
      padding: ${props => props.theme.spacing.xs} ${props => props.theme.spacing.sm};
      font-size: ${props => props.theme.typography.fontSize.xs};
      border-radius: ${props => props.theme.borderRadius.sm};
      min-height: 1.75rem;
    `}

    ${size === 'sm' && css`
      padding: ${props => props.theme.spacing.xs} ${props => props.theme.spacing.md};
      font-size: ${props => props.theme.typography.fontSize.sm};
      border-radius: ${props => props.theme.borderRadius.base};
      min-height: 2rem;
    `}

    ${size === 'md' && css`
      padding: ${props => props.theme.spacing.sm} ${props => props.theme.spacing.lg};
      font-size: ${props => props.theme.typography.fontSize.base};
      border-radius: ${props => props.theme.borderRadius.md};
      min-height: 2.5rem;
    `}

    ${size === 'lg' && css`
      padding: ${props => props.theme.spacing.sm} ${props => props.theme.spacing.xl};
      font-size: ${props => props.theme.typography.fontSize.lg};
      border-radius: ${props => props.theme.borderRadius.md};
      min-height: 3rem;
    `}

    ${size === 'xl' && css`
      padding: ${props => props.theme.spacing.md} ${props => props.theme.spacing['2xl']};
      font-size: ${props => props.theme.typography.fontSize.xl};
      border-radius: ${props => props.theme.borderRadius.lg};
      min-height: 3.5rem;
    `}
  `,

  /**
   * Focus ring styles
   */
  focusRing: (color?: string) => css`
    &:focus-visible {
      outline: 2px solid ${props => color || props.theme.colors.primary[500]};
      outline-offset: 2px;
    }
  `,

  /**
   * Truncate text with ellipsis
   */
  truncate: css`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,

  /**
   * Screen reader only
   */
  srOnly: css`
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border-width: 0;
  `,

  /**
   * Responsive media query helpers
   */
  media: {
    sm: (styles: any) => css`
      @media (min-width: ${props => props.theme.breakpoints.sm}) {
        ${styles}
      }
    `,
    md: (styles: any) => css`
      @media (min-width: ${props => props.theme.breakpoints.md}) {
        ${styles}
      }
    `,
    lg: (styles: any) => css`
      @media (min-width: ${props => props.theme.breakpoints.lg}) {
        ${styles}
      }
    `,
    xl: (styles: any) => css`
      @media (min-width: ${props => props.theme.breakpoints.xl}) {
        ${styles}
      }
    `,
    '2xl': (styles: any) => css`
      @media (min-width: ${props => props.theme.breakpoints['2xl']}) {
        ${styles}
      }
    `,
  },
};

/**
 * Global styles for Semiont components
 */
export const SemiontGlobalStyles = css`
  /* Import CSS variables */
  :root {
    /* Primary colors */
    ${Object.entries(tokens.colors.primary).map(([key, value]) =>
      `--semiont-color-primary-${key}: ${value};`
    ).join('\n')}

    /* Secondary colors */
    ${Object.entries(tokens.colors.secondary).map(([key, value]) =>
      `--semiont-color-secondary-${key}: ${value};`
    ).join('\n')}

    /* Neutral colors */
    ${Object.entries(tokens.colors.neutral).map(([key, value]) =>
      `--semiont-color-neutral-${key}: ${value};`
    ).join('\n')}

    /* Semantic colors */
    ${Object.entries(tokens.colors.semantic).map(([key, value]) => {
      const kebabKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
      return `--semiont-color-${kebabKey}: ${value};`;
    }).join('\n')}

    /* Spacing */
    ${Object.entries(tokens.spacing).map(([key, value]) =>
      `--semiont-spacing-${key}: ${value};`
    ).join('\n')}

    /* Typography */
    --semiont-font-sans: ${tokens.typography.fontFamily.sans};
    --semiont-font-mono: ${tokens.typography.fontFamily.mono};

    /* Font sizes */
    ${Object.entries(tokens.typography.fontSize).map(([key, value]) =>
      `--semiont-text-${key}: ${value};`
    ).join('\n')}

    /* Font weights */
    ${Object.entries(tokens.typography.fontWeight).map(([key, value]) =>
      `--semiont-font-${key}: ${value};`
    ).join('\n')}

    /* Border radius */
    ${Object.entries(tokens.borderRadius).map(([key, value]) =>
      `--semiont-radius-${key}: ${value};`
    ).join('\n')}

    /* Shadows */
    ${Object.entries(tokens.shadows).map(([key, value]) =>
      `--semiont-shadow-${key}: ${value};`
    ).join('\n')}

    /* Transitions */
    ${Object.entries(tokens.transitions.duration).map(([key, value]) =>
      `--semiont-duration-${key}: ${value};`
    ).join('\n')}
  }
`;

/**
 * Helper function to create styled Semiont components
 *
 * Usage:
 * ```tsx
 * import styled from 'styled-components';
 * import { createStyledSemiontButton } from '@semiont/react-ui/integrations';
 *
 * const StyledButton = createStyledSemiontButton(styled);
 * ```
 */
export function createStyledSemiontButton(styled: any) {
  return styled.button.attrs((props: any) => ({
    'data-variant': props.variant,
    'data-size': props.size,
    'data-loading': props.loading ? 'true' : undefined,
    'data-full-width': props.fullWidth ? 'true' : undefined,
    'data-icon-only': props.iconOnly ? 'true' : undefined,
    'data-active': props.active ? 'true' : undefined,
    'data-disabled': props.disabled ? 'true' : undefined,
    className: `semiont-button ${props.className || ''}`.trim(),
  }))`
    ${semiontMixins.buttonBase}
    ${(props: any) => semiontMixins.buttonVariant(props.variant || 'primary')}
    ${(props: any) => semiontMixins.buttonSize(props.size || 'md')}

    ${(props: any) => props.fullWidth && css`
      width: 100%;
    `}

    ${(props: any) => props.loading && css`
      pointer-events: none;
      opacity: 0.75;
    `}

    ${(props: any) => props.iconOnly && css`
      padding: ${props.theme.spacing.sm};
      aspect-ratio: 1;
    `}
  `;
}