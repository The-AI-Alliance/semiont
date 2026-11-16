/**
 * Centralized button styles matching Figma design
 * Two primary styles from authenticated home page:
 * 1. Primary (cyan/blue gradient) - for main CTAs
 * 2. Secondary (gray with black outline) - for secondary actions
 */

export const buttonStyles = {
  // Primary button - cyan/blue gradient (used for main CTAs like "New Document", "Sign In", "Sign Up")
  primary: {
    base: "semiont-button semiont-button--primary",
    large: "semiont-button semiont-button--primary semiont-button--large",
  },

  // Secondary button - gray with subtle outline (used for "Search", "Cancel", etc.)
  secondary: {
    base: "semiont-button semiont-button--secondary",
    withScale: "semiont-button semiont-button--secondary semiont-button--scale",
  },

  // Tertiary button - minimal style for less important actions
  tertiary: {
    base: "semiont-button semiont-button--tertiary",
  },

  // Danger button - for destructive actions
  danger: {
    base: "semiont-button semiont-button--danger",
  },

  // Warning/Yellow button - for highlight actions
  warning: {
    base: "semiont-button semiont-button--warning",
  },

  // Utility function to combine classes
  combine: (...classes: string[]) => classes.filter(Boolean).join(' '),
} as const;