/**
 * Tailwind CSS Plugin for Semiont Components
 *
 * This plugin provides utilities for styling Semiont components
 * using Tailwind CSS classes while respecting the data-attribute architecture.
 */

const plugin = require('tailwindcss/plugin');
const { tokens } = require('../design-tokens');

module.exports = plugin(function({ addBase, addComponents, addUtilities, theme }) {
  // Add base styles for CSS variables
  addBase({
    ':root': Object.entries(tokens.colors.primary).reduce((acc, [key, value]) => ({
      ...acc,
      [`--semiont-color-primary-${key}`]: value
    }), {}),
  });

  // Add component styles
  addComponents({
    // Button component styles
    '.semiont-button': {
      '@apply relative inline-flex items-center justify-center': {},
      '@apply font-medium transition-all duration-200': {},
      '@apply focus:outline-none focus:ring-2 focus:ring-offset-2': {},
      '@apply disabled:opacity-50 disabled:cursor-not-allowed': {},
    },

    // Button variants
    '.semiont-button[data-variant="primary"]': {
      '@apply bg-blue-500 text-white hover:bg-blue-600 active:bg-blue-700': {},
      '@apply focus:ring-blue-500': {},
    },
    '.semiont-button[data-variant="secondary"]': {
      '@apply bg-gray-100 text-gray-900 hover:bg-gray-200 active:bg-gray-300': {},
      '@apply focus:ring-gray-500': {},
    },
    '.semiont-button[data-variant="tertiary"]': {
      '@apply bg-transparent text-blue-600 ring-1 ring-inset ring-blue-200': {},
      '@apply hover:bg-blue-50 hover:ring-blue-300 active:bg-blue-100': {},
      '@apply focus:ring-blue-500': {},
    },
    '.semiont-button[data-variant="danger"]': {
      '@apply bg-red-500 text-white hover:bg-red-600 active:bg-red-700': {},
      '@apply focus:ring-red-500': {},
    },
    '.semiont-button[data-variant="warning"]': {
      '@apply bg-amber-500 text-gray-900 hover:bg-amber-600 active:bg-amber-700': {},
      '@apply focus:ring-amber-500': {},
    },
    '.semiont-button[data-variant="ghost"]': {
      '@apply bg-transparent text-gray-700 hover:bg-gray-100 active:bg-gray-200': {},
      '@apply focus:ring-gray-500': {},
    },

    // Button sizes
    '.semiont-button[data-size="xs"]': {
      '@apply px-2 py-1 text-xs rounded min-h-[1.75rem]': {},
    },
    '.semiont-button[data-size="sm"]': {
      '@apply px-3 py-1.5 text-sm rounded min-h-[2rem]': {},
    },
    '.semiont-button[data-size="md"]': {
      '@apply px-4 py-2 text-base rounded-md min-h-[2.5rem]': {},
    },
    '.semiont-button[data-size="lg"]': {
      '@apply px-6 py-2.5 text-lg rounded-md min-h-[3rem]': {},
    },
    '.semiont-button[data-size="xl"]': {
      '@apply px-8 py-3 text-xl rounded-lg min-h-[3.5rem]': {},
    },

    // Icon-only buttons
    '.semiont-button[data-icon-only="true"][data-size="xs"]': {
      '@apply p-1 w-7 h-7': {},
    },
    '.semiont-button[data-icon-only="true"][data-size="sm"]': {
      '@apply p-1.5 w-8 h-8': {},
    },
    '.semiont-button[data-icon-only="true"][data-size="md"]': {
      '@apply p-2 w-10 h-10': {},
    },
    '.semiont-button[data-icon-only="true"][data-size="lg"]': {
      '@apply p-2.5 w-12 h-12': {},
    },
    '.semiont-button[data-icon-only="true"][data-size="xl"]': {
      '@apply p-3 w-14 h-14': {},
    },

    // Full width
    '.semiont-button[data-full-width="true"]': {
      '@apply w-full': {},
    },

    // Loading state
    '.semiont-button[data-loading="true"]': {
      '@apply pointer-events-none': {},
    },
    '.semiont-button[data-loading="true"] .semiont-button-content': {
      '@apply invisible': {},
    },
    '.semiont-button[data-loading="true"] .semiont-button-icon': {
      '@apply invisible': {},
    },

    // Button spinner
    '.semiont-button-spinner': {
      '@apply absolute inset-0 flex items-center justify-center': {},
    },
    '.semiont-spinner-svg': {
      '@apply animate-spin w-5 h-5': {},
    },

    // Button content and icons
    '.semiont-button-content': {
      '@apply inline-flex items-center': {},
    },
    '.semiont-button-icon': {
      '@apply inline-flex items-center justify-center flex-shrink-0': {},
    },
    '.semiont-button-icon-left': {
      '@apply mr-2': {},
    },
    '.semiont-button-icon-right': {
      '@apply ml-2': {},
    },

    // Button group
    '.semiont-button-group': {
      '@apply flex': {},
    },
    '.semiont-button-group[data-orientation="horizontal"]': {
      '@apply flex-row': {},
    },
    '.semiont-button-group[data-orientation="vertical"]': {
      '@apply flex-col': {},
    },

    // Button group spacing
    '.semiont-button-group[data-spacing="xs"]': {
      '@apply gap-1': {},
    },
    '.semiont-button-group[data-spacing="sm"]': {
      '@apply gap-2': {},
    },
    '.semiont-button-group[data-spacing="md"]': {
      '@apply gap-4': {},
    },
    '.semiont-button-group[data-spacing="lg"]': {
      '@apply gap-6': {},
    },

    // Attached button groups
    '.semiont-button-group[data-attached="true"]': {
      '@apply gap-0': {},
    },
    '.semiont-button-group[data-attached="true"][data-orientation="horizontal"] .semiont-button:not(:first-child)': {
      '@apply rounded-l-none -ml-px': {},
    },
    '.semiont-button-group[data-attached="true"][data-orientation="horizontal"] .semiont-button:not(:last-child)': {
      '@apply rounded-r-none': {},
    },
    '.semiont-button-group[data-attached="true"][data-orientation="vertical"] .semiont-button:not(:first-child)': {
      '@apply rounded-t-none -mt-px': {},
    },
    '.semiont-button-group[data-attached="true"][data-orientation="vertical"] .semiont-button:not(:last-child)': {
      '@apply rounded-b-none': {},
    },
  });

  // Add utility classes for custom data attributes
  addUtilities({
    '.semiont-variant-primary': {
      '&[data-variant="primary"]': {
        '@apply bg-blue-500 text-white': {},
      },
    },
    '.semiont-variant-secondary': {
      '&[data-variant="secondary"]': {
        '@apply bg-gray-100 text-gray-900': {},
      },
    },
    '.semiont-size-sm': {
      '&[data-size="sm"]': {
        '@apply px-3 py-1.5 text-sm': {},
      },
    },
    '.semiont-size-md': {
      '&[data-size="md"]': {
        '@apply px-4 py-2 text-base': {},
      },
    },
    '.semiont-size-lg': {
      '&[data-size="lg"]': {
        '@apply px-6 py-2.5 text-lg': {},
      },
    },
  });
}, {
  // Plugin configuration
  theme: {
    extend: {
      colors: {
        semiont: {
          primary: tokens.colors.primary,
          secondary: tokens.colors.secondary,
          semantic: tokens.colors.semantic,
          neutral: tokens.colors.neutral,
        },
      },
      spacing: tokens.spacing,
      fontSize: tokens.typography.fontSize,
      borderRadius: tokens.borderRadius,
      transitionDuration: tokens.transitions.duration,
    },
  },
});

// Export for CommonJS
module.exports.semiontPlugin = module.exports;

// Export for ESM
module.exports.default = module.exports;