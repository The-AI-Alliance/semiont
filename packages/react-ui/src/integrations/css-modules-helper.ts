/**
 * CSS Modules Helper for Semiont Components
 *
 * This helper provides utilities for integrating Semiont components
 * with CSS Modules while preserving the data-attribute architecture.
 */

import { clsx } from 'clsx';

/**
 * Creates a className builder for Semiont components with CSS Modules
 *
 * @param styles - The CSS Modules styles object
 * @param baseClass - The base Semiont class name (e.g., 'semiont-button')
 * @returns A function that builds the className string
 */
export function createSemiontClassName(
  styles: Record<string, string>,
  baseClass: string
) {
  return function buildClassName(
    dataAttributes: Record<string, string | boolean | undefined>,
    additionalClasses?: string
  ): string {
    const classes = [baseClass];

    // Map the base class to its CSS Module equivalent if it exists
    if (styles[baseClass]) {
      classes.push(styles[baseClass]);
    }

    // Add any additional classes
    if (additionalClasses) {
      classes.push(additionalClasses);
    }

    return clsx(...classes);
  };
}

/**
 * Helper to generate data attributes object from component props
 *
 * @param props - Component props
 * @returns Data attributes object
 */
export function generateDataAttributes(props: {
  variant?: string;
  size?: string;
  loading?: boolean;
  fullWidth?: boolean;
  iconOnly?: boolean;
  active?: boolean;
  disabled?: boolean;
  orientation?: string;
  attached?: boolean;
  spacing?: string;
  [key: string]: any;
}): Record<string, string | undefined> {
  return {
    'data-variant': props.variant,
    'data-size': props.size,
    'data-loading': props.loading ? 'true' : undefined,
    'data-full-width': props.fullWidth ? 'true' : undefined,
    'data-icon-only': props.iconOnly ? 'true' : undefined,
    'data-active': props.active ? 'true' : undefined,
    'data-disabled': props.disabled ? 'true' : undefined,
    'data-orientation': props.orientation,
    'data-attached': props.attached ? 'true' : undefined,
    'data-spacing': props.attached ? undefined : props.spacing,
  };
}

/**
 * Merges data attributes into props object
 *
 * @param props - Original props
 * @param dataAttributes - Data attributes to merge
 * @returns Merged props object
 */
export function mergeDataAttributes<T extends Record<string, any>>(
  props: T,
  dataAttributes: Record<string, string | undefined>
): T {
  const merged = { ...props };

  Object.entries(dataAttributes).forEach(([key, value]) => {
    if (value !== undefined) {
      merged[key] = value;
    }
  });

  return merged;
}

/**
 * Example wrapper component for CSS Modules integration
 *
 * Usage:
 * ```tsx
 * import styles from './CustomButton.module.css';
 * import { Button } from '@semiont/react-ui';
 * import { withCSSModules } from '@semiont/react-ui/integrations';
 *
 * const CustomButton = withCSSModules(Button, styles, 'button');
 * ```
 */
export function withCSSModules<P extends { className?: string }>(
  Component: React.ComponentType<P>,
  styles: Record<string, string>,
  baseClassName: string
) {
  return function WrappedComponent(props: P) {
    const className = clsx(
      baseClassName,
      styles[baseClassName],
      props.className
    );

    return <Component {...props} className={className} />;
  };
}

/**
 * CSS Modules configuration helper for build tools
 *
 * This provides the necessary configuration for CSS Modules
 * to work with Semiont's data-attribute selectors
 */
export const cssModulesConfig = {
  // PostCSS config for CSS Modules
  postcss: {
    plugins: [
      // Preserve data-attribute selectors
      {
        postcssPlugin: 'preserve-data-attributes',
        Once(root: any) {
          root.walkRules((rule: any) => {
            // Don't hash data-attribute selectors
            if (rule.selector.includes('[data-')) {
              rule.selector = rule.selector.replace(
                /\.([a-zA-Z][a-zA-Z0-9-_]*)/g,
                (match: string, className: string) => {
                  // Keep the class name but mark it as global
                  return `:global(.${className})`;
                }
              );
            }
          });
        },
      },
    ],
  },

  // Webpack config for CSS Modules
  webpack: {
    cssLoader: {
      modules: {
        // Custom naming for CSS Modules
        localIdentName: '[name]__[local]___[hash:base64:5]',
        // Preserve data-attribute selectors
        getLocalIdent: (
          context: any,
          localIdentName: string,
          localName: string
        ) => {
          // Don't hash Semiont base classes
          if (localName.startsWith('semiont-')) {
            return localName;
          }
          // Use default hashing for other classes
          return null;
        },
      },
    },
  },

  // Vite config for CSS Modules
  vite: {
    css: {
      modules: {
        // Custom naming for CSS Modules
        generateScopedName: '[name]__[local]___[hash:base64:5]',
        // Preserve specific selectors
        scopeBehaviour: 'local' as const,
        // Global patterns
        globalModulePaths: [/semiont-.*\.css$/],
      },
    },
  },
};

/**
 * Type definitions for CSS Modules with Semiont components
 */
export interface SemiontCSSModules {
  button?: string;
  'button-content'?: string;
  'button-icon'?: string;
  'button-icon-left'?: string;
  'button-icon-right'?: string;
  'button-spinner'?: string;
  'button-group'?: string;
  [key: string]: string | undefined;
}

/**
 * Helper to type CSS Modules imports
 *
 * Usage:
 * ```tsx
 * import { defineCSSModules } from '@semiont/react-ui/integrations';
 * import rawStyles from './Button.module.css';
 *
 * const styles = defineCSSModules<SemiontCSSModules>(rawStyles);
 * ```
 */
export function defineCSSModules<T extends SemiontCSSModules>(
  styles: Record<string, string>
): T {
  return styles as T;
}