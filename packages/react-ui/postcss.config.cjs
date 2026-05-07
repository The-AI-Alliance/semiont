/**
 * PostCSS Configuration for @semiont/react-ui
 *
 * Enables CSS source maps for better debugging experience
 * while maintaining the modular CSS architecture.
 */

module.exports = {
  // Source map configuration
  map: process.env.NODE_ENV === 'production'
    ? {
        // Production: Separate map files, no inline reference
        inline: false,
        annotation: false, // Don't add sourceMappingURL (serve conditionally)
        sourcesContent: false // Reduce file size
      }
    : {
        // Development: Full source maps for debugging
        inline: false,      // Keep maps in separate files
        annotation: true,   // Add sourceMappingURL comment
        sourcesContent: true // Include original source for debugging
      },

  plugins: {
    // Handle @import statements (critical for our modular structure)
    'postcss-import': {
      path: ['src/styles'],
      resolve: (id, basedir) => {
        // Handle relative imports
        if (id.startsWith('./')) {
          return id;
        }
        // Handle absolute imports from styles root
        return `./src/styles/${id}`;
      }
    },

    // Add vendor prefixes for better browser support
    'autoprefixer': {
      // Target browsers based on browserslist config
      // or fallback to reasonable defaults
      overrideBrowserslist: [
        '> 1%',
        'last 2 versions',
        'Firefox ESR',
        'not dead'
      ]
    },

    // Optimize for production (only in production builds)
    ...(process.env.NODE_ENV === 'production' && {
      'cssnano': {
        preset: ['default', {
          // Preserve our accessibility utilities
          discardComments: {
            removeAll: true,
            removeAllButFirst: false
          },
          // Don't normalize whitespace (preserves readability)
          normalizeWhitespace: false,
          // Keep our custom properties
          customProperties: false,
          // Preserve important declarations (used in utilities)
          discardUnused: false,
          // Don't merge rules (maintains modularity)
          mergeRules: false,
          // Keep calc() for browser compatibility
          calc: false
        }]
      }
    })
  }
}