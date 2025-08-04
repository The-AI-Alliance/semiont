/**
 * Performance Configuration
 * 
 * This file contains performance targets and thresholds for monitoring
 * application performance over time.
 */

module.exports = {
  // Bundle size thresholds (in bytes)
  bundleSize: {
    maxTotalSize: 2 * 1024 * 1024, // 2MB
    maxChunkSize: 500 * 1024,      // 500KB
    maxCssSize: 100 * 1024,        // 100KB
    warningThreshold: 0.9,         // Warn at 90% of max
  },

  // Performance metrics thresholds
  metrics: {
    // Core Web Vitals
    largestContentfulPaint: 2500,  // 2.5s
    firstInputDelay: 100,          // 100ms
    cumulativeLayoutShift: 0.1,    // 0.1
    
    // Additional metrics
    firstContentfulPaint: 1800,    // 1.8s
    timeToInteractive: 3800,       // 3.8s
    totalBlockingTime: 300,        // 300ms
    
    // Lighthouse scores (0-1)
    performance: 0.8,
    accessibility: 0.9,
    bestPractices: 0.8,
    seo: 0.8,
  },

  // Dependencies to monitor
  dependencies: {
    // Flag large dependencies
    maxDependencySize: 200 * 1024, // 200KB
    
    // Known large dependencies to monitor
    watchList: [
      '@tanstack/react-query',
      'next-auth',
      'next',
      'react',
      'react-dom'
    ],
  },

  // Analysis configuration
  analysis: {
    // Generate detailed reports
    generateReports: true,
    
    // Compare with previous builds
    compareWithPrevious: true,
    
    // Fail build on threshold violations
    failOnThreshold: false, // Set to true for CI/CD
    
    // Output directory for reports
    outputDir: './performance-reports',
  },

  // Optimization suggestions
  suggestions: {
    // Suggest dynamic imports for large components
    dynamicImportThreshold: 50 * 1024, // 50KB
    
    // Suggest lazy loading for images
    imageLazyLoadThreshold: 10, // More than 10 images
    
    // Suggest code splitting for routes
    routeSplittingThreshold: 3, // More than 3 routes
  }
};