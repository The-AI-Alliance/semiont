# Performance Optimization Guide

**Last Updated**: 2025-10-25

Complete guide to performance monitoring, bundle optimization, and best practices for the Semiont frontend.

## Table of Contents

- [Quick Start](#quick-start)
- [Performance Best Practices](#performance-best-practices)
- [Tools & Configuration](#tools--configuration)
- [Bundle Optimization](#bundle-optimization)
- [Performance Monitoring](#performance-monitoring)
- [CI/CD Integration](#cicd-integration)
- [Troubleshooting](#troubleshooting)
- [Related Documentation](#related-documentation)

## Quick Start

```bash
# Run comprehensive performance analysis
npm run perf               # Full performance check (bundle + Lighthouse)
npm run perf-check         # Alias for perf

# Just bundle analysis
npm run analyze            # Generate bundle analysis report
npm run analyze-bundle     # Custom bundle analyzer
npm run bundle-analyzer    # Webpack bundle analyzer

# Just performance monitoring
npm run perf-monitor       # Custom performance monitoring
npm run lighthouse         # Lighthouse CI (requires running server)
```

## Performance Best Practices

### 1. Code Splitting

Automatic with Next.js App Router - pages and components are split into separate bundles.

**Manual code splitting** for large components:
```typescript
import dynamic from 'next/dynamic';

const HeavyComponent = dynamic(() => import('@/components/HeavyComponent'), {
  loading: () => <div>Loading...</div>,
  ssr: false  // Skip server-side rendering if not needed
});
```

### 2. Image Optimization

Use Next.js `Image` component for automatic optimization:
```typescript
import Image from 'next/image';

<Image
  src="/photo.jpg"
  width={500}
  height={300}
  alt="Description"
  loading="lazy"  // Lazy load images
  placeholder="blur"  // Show blur while loading
/>
```

**Benefits**:
- Automatic WebP/AVIF conversion
- Responsive images
- Lazy loading
- Blur placeholder

### 3. API Caching

Configured with TanStack Query for optimal data fetching:
```typescript
const { data } = api.documents.list.useQuery({
  staleTime: 1000 * 60 * 5,  // Cache for 5 minutes
  cacheTime: 1000 * 60 * 30,  // Keep in cache for 30 minutes
  refetchOnWindowFocus: false  // Don't refetch on window focus
});
```

### 4. Error Boundaries

Prevent cascading failures and improve user experience:
```typescript
<AsyncErrorBoundary>
  <ExpensiveComponent />
</AsyncErrorBoundary>
```

**Benefits**:
- Graceful degradation
- Prevents full page crashes
- Better error reporting

### 5. Lazy Loading

Components loaded on demand:
```typescript
// Route-based lazy loading (automatic)
const DashboardPage = dynamic(() => import('./dashboard/page'));

// Component-based lazy loading (manual)
const Chart = dynamic(() => import('@/components/Chart'), {
  loading: () => <ChartSkeleton />
});
```

## Tools & Configuration

### Bundle Analysis
- **@next/bundle-analyzer**: Visual bundle analysis
- **webpack-bundle-analyzer**: Detailed webpack bundle analysis
- **Custom scripts**: Automated analysis and recommendations

### Performance Monitoring
- **Lighthouse CI**: Core Web Vitals and performance metrics
- **Custom monitoring**: Bundle size tracking and thresholds
- **Performance reports**: Historical tracking and analysis

### Configuration Files
- `next.config.js`: Bundle optimization settings
- `lighthouserc.json`: Lighthouse CI configuration
- `performance.config.js`: Performance thresholds and targets
- `scripts/performance-monitor.js`: Custom monitoring logic

## Bundle Optimization Features

### Implemented Optimizations
1. **Code Splitting**: Automatic vendor and common chunk splitting
2. **Image Optimization**: Next.js Image component with WebP/AVIF support
3. **Tree Shaking**: Unused code elimination
4. **Minification**: SWC-based minification
5. **Compression**: Gzip/Brotli compression enabled
6. **Font Optimization**: Automatic font optimization

### Bundle Size Targets
- **Total Bundle**: < 2MB
- **Individual Chunks**: < 500KB
- **CSS Bundle**: < 100KB
- **Large Assets**: < 50KB (for dynamic import consideration)

## Performance Metrics

### Core Web Vitals
- **Largest Contentful Paint (LCP)**: < 2.5s
- **First Input Delay (FID)**: < 100ms
- **Cumulative Layout Shift (CLS)**: < 0.1

### Additional Metrics
- **First Contentful Paint (FCP)**: < 1.8s
- **Time to Interactive (TTI)**: < 3.8s
- **Total Blocking Time (TBT)**: < 300ms

### Lighthouse Scores
- **Performance**: > 80%
- **Accessibility**: > 90%
- **Best Practices**: > 80%
- **SEO**: > 80%

## Monitoring Commands

### Bundle Analysis
```bash
# Generate bundle analysis report
npm run analyze

# Run custom bundle analyzer
npm run analyze-bundle

# Open webpack bundle analyzer
npm run bundle-analyzer
```

### Performance Testing
```bash
# Full performance check
npm run perf-check

# Custom performance monitoring
npm run perf-monitor

# Lighthouse analysis (requires server)
npm start & npm run lighthouse
```

## Reports & Output

### Generated Reports
- `bundle-report.html`: Visual bundle analysis
- `bundle-stats.json`: Detailed bundle statistics
- `performance-reports/`: Historical performance data
- `lighthouse-reports/`: Lighthouse CI results

### Report Contents
1. **Bundle Size Analysis**: Total size, chunk breakdown, dependency analysis
2. **Performance Recommendations**: Actionable optimization suggestions
3. **Asset Analysis**: Large files and optimization opportunities
4. **Historical Tracking**: Performance trends over time

## Optimization Recommendations

### Automatic Suggestions
The monitoring system provides automated recommendations for:
- Bundle size optimization
- Code splitting opportunities
- Large dependency replacements
- Image optimization
- CSS optimization
- General performance best practices

### Manual Optimization Areas
1. **Dynamic Imports**: Use for large components/features
2. **Image Optimization**: Implement lazy loading and responsive images
3. **Dependency Audit**: Regular review of package sizes
4. **Caching Strategy**: Optimize browser and CDN caching
5. **Database/API Optimization**: Reduce payload sizes

## CI/CD Integration

### GitHub Actions Example
```yaml
- name: Performance Analysis
  run: |
    npm ci
    npm run perf-check
    # Upload reports to artifacts
```

### Performance Budgets
Set performance budgets in your CI/CD pipeline:
- Fail builds if bundle size exceeds thresholds
- Monitor Core Web Vitals regression
- Track performance metrics over time

## Troubleshooting

### Common Issues
1. **Large Bundle Size**: Check for duplicate dependencies, unused code
2. **Poor LCP**: Optimize images, fonts, and critical resources
3. **High CLS**: Ensure proper sizing for images and ads
4. **Slow TTI**: Reduce JavaScript execution time

### Debug Commands
```bash
# Check for duplicate packages
npx duplicate-package-checker-webpack

# Analyze unused dependencies
npx depcheck

# Bundle analyzer with source maps
ANALYZE=true npm run build
```

## Best Practices

### Development
1. Regular performance monitoring
2. Bundle size awareness during development
3. Performance testing for new features
4. Accessibility-first development

### Production
1. Enable all optimizations
2. Monitor Core Web Vitals
3. Set up performance alerts
4. Regular performance audits

## Related Documentation

### Frontend Guides
- [Development Guide](./DEVELOPMENT.md) - Local development workflows
- [Testing Guide](./TESTING.md) - Test structure and running tests
- [Deployment Guide](./DEPLOYMENT.md) - Publishing and deployment

### Architecture
- [Frontend Architecture](./ARCHITECTURE.md) - High-level system design
- [Rendering Architecture](./RENDERING-ARCHITECTURE.md) - Document rendering pipeline

### External Resources
- [Next.js Performance](https://nextjs.org/docs/advanced-features/measuring-performance)
- [Web Vitals](https://web.dev/vitals/)
- [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci)
- [Bundle Analyzer](https://github.com/webpack-contrib/webpack-bundle-analyzer)

---

**Last Updated**: 2025-10-25
**Performance Target**: Lighthouse Score > 80%