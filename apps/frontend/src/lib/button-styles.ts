/**
 * Centralized button styles matching Figma design
 * Two primary styles from authenticated home page:
 * 1. Primary (cyan/blue gradient) - for main CTAs
 * 2. Secondary (gray with black outline) - for secondary actions
 */

export const buttonStyles = {
  // Primary button - cyan/blue gradient (used for main CTAs like "New Document", "Sign In", "Sign Up")
  primary: {
    base: "px-6 py-2 bg-gradient-to-r from-cyan-500/20 to-blue-500/20 hover:from-cyan-600 hover:to-blue-600 dark:from-cyan-600/20 dark:to-blue-600/20 dark:hover:from-cyan-500 dark:hover:to-blue-500 text-cyan-700 hover:text-white dark:text-cyan-400 dark:hover:text-white border border-cyan-400/30 hover:border-cyan-600 dark:border-cyan-500/30 dark:hover:border-cyan-400 rounded-lg transition-all duration-300 backdrop-blur-sm disabled:opacity-50 disabled:cursor-not-allowed",
    large: "w-full py-3 bg-gradient-to-r from-cyan-500/20 to-blue-500/20 hover:from-cyan-600 hover:to-blue-600 dark:from-cyan-600/20 dark:to-blue-600/20 dark:hover:from-cyan-500 dark:hover:to-blue-500 text-cyan-700 hover:text-white dark:text-cyan-400 dark:hover:text-white border border-cyan-400/30 hover:border-cyan-600 dark:border-cyan-500/30 dark:hover:border-cyan-400 rounded-lg transition-all duration-300 transform hover:scale-[1.02] font-medium flex items-center justify-center gap-2 backdrop-blur-sm disabled:opacity-50 disabled:cursor-not-allowed",
  },
  
  // Secondary button - gray with subtle outline (used for "Search", "Cancel", etc.)
  secondary: {
    base: "px-6 py-2 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 border border-black/20 dark:border-white/20 text-gray-900 dark:text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300",
    withScale: "px-6 py-2 bg-black/10 hover:bg-black/20 dark:bg-white/10 dark:hover:bg-white/20 border border-black/20 dark:border-white/20 text-gray-900 dark:text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 transform hover:scale-105",
  },

  // Tertiary button - minimal style for less important actions
  tertiary: {
    base: "px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors",
  },

  // Danger button - for destructive actions
  danger: {
    base: "px-6 py-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg transition-all duration-300",
  },

  // Utility function to combine classes
  combine: (...classes: string[]) => classes.filter(Boolean).join(' '),
} as const;