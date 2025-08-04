# Performance Monitoring & Bundle Analysis

This document describes the performance monitoring and bundle analysis setup for the frontend application.

## Quick Start

```bash
# Run comprehensive performance analysis
npm run perf-check

# Just bundle analysis
npm run analyze

# Just performance monitoring
npm run perf-monitor

# Lighthouse CI (requires running server)
npm run lighthouse
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

## Resources

- [Next.js Performance](https://nextjs.org/docs/advanced-features/measuring-performance)
- [Web Vitals](https://web.dev/vitals/)
- [Lighthouse CI](https://github.com/GoogleChrome/lighthouse-ci)
- [Bundle Analyzer](https://github.com/webpack-contrib/webpack-bundle-analyzer)